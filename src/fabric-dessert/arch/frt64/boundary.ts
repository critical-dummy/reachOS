import {
  ExecutionStepResult,
  Frt64CoreConfig,
  Frt64CoreRunState,
  Frt64CoreStatus,
  Frt64ExecutionFamily,
  Frt64TopologyConfig,
  InstructionFetchResult,
} from './types';
import {Address64} from '../../types';

export interface IFrt64BusMaster {
  readPhysical(address: Address64, sizeBytes: number): Uint8Array;
  writePhysical(address: Address64, data: Uint8Array): void;
}

export interface IFrt64CoreBoundary {
  readonly coreId: number;
  readonly clusterId: number;
  readonly pc: Address64;
  readonly resetVector: Address64;
  getStatus(): Frt64CoreStatus;
  getActiveFamily(): Frt64ExecutionFamily;
  switchExecutionFamily(targetFamily: Frt64ExecutionFamily): boolean;
  attachBusMaster(bus: IFrt64BusMaster): void;
  setResetVector(vector: Address64): void;
  setProgramCounter(address: Address64): void;
  reset(vector?: Address64): void;
  halt(): void;
  resume(): void;
  signalInterrupt(irqVector: number): void;
  fetchInstruction(sizeBytes?: number): InstructionFetchResult;
  step(): ExecutionStepResult;
}

export interface IFrt64CpuBoundary {
  readonly coreCount: number;
  readonly defaultFamily: Frt64ExecutionFamily;
  getCore(coreId: number): IFrt64CoreBoundary | undefined;
  getAllCores(): readonly IFrt64CoreBoundary[];
  attachBusMaster(bus: IFrt64BusMaster): void;
  setResetVectorAll(vector: Address64): void;
  resetAll(vector?: Address64): void;
  haltAll(): void;
  resumeAll(): void;
  signalGlobalInterrupt(irqVector: number): void;
}

export class Frt64CoreBoundary implements IFrt64CoreBoundary {
  readonly coreId: number;
  readonly clusterId: number;
  private runState: Frt64CoreRunState = Frt64CoreRunState.RESET;
  private activeFamily: Frt64ExecutionFamily;
  private cyclesExecuted = 0n;
  private currentPc: Address64;
  private currentResetVector: Address64;
  protected busMaster: IFrt64BusMaster | null = null;

  constructor(config: Frt64CoreConfig) {
    this.coreId = config.coreId;
    this.clusterId = config.clusterId ?? 0;
    this.activeFamily = config.initialFamily;
    this.currentResetVector = config.resetVector ?? 0n;
    this.currentPc = this.currentResetVector;
  }

  get pc(): Address64 {
    return this.currentPc;
  }

  get resetVector(): Address64 {
    return this.currentResetVector;
  }

  setResetVector(vector: Address64): void {
    this.currentResetVector = vector;
  }

  setProgramCounter(address: Address64): void {
    this.currentPc = address;
  }

  getStatus(): Frt64CoreStatus {
    return {
      coreId: this.coreId,
      runState: this.runState,
      activeFamily: this.activeFamily,
      cyclesExecuted: this.cyclesExecuted,
      pc: this.currentPc,
      resetVector: this.currentResetVector,
    };
  }

  getActiveFamily(): Frt64ExecutionFamily {
    return this.activeFamily;
  }

  switchExecutionFamily(targetFamily: Frt64ExecutionFamily): boolean {
    if (this.activeFamily === targetFamily) {
      return true;
    }
    // Family switching is managed by the architectural boundary
    this.activeFamily = targetFamily;
    return true;
  }

  attachBusMaster(bus: IFrt64BusMaster): void {
    this.busMaster = bus;
  }

  reset(vector?: Address64): void {
    if (vector !== undefined) {
      this.currentResetVector = vector;
    }
    this.currentPc = this.currentResetVector;
    this.runState = Frt64CoreRunState.RESET;
    this.cyclesExecuted = 0n;
  }

  halt(): void {
    this.runState = Frt64CoreRunState.HALTED;
  }

  resume(): void {
    if (this.runState === Frt64CoreRunState.HALTED || this.runState === Frt64CoreRunState.RESET) {
      this.runState = Frt64CoreRunState.RUNNING;
    }
  }

  signalInterrupt(_irqVector: number): void {
    void _irqVector;
  }

  fetchInstruction(sizeBytes = 4): InstructionFetchResult {
    if (!this.busMaster) {
      return {
        success: false,
        address: this.currentPc,
        sizeBytes,
        fault: 'NO_BUS_MASTER_ATTACHED',
      };
    }

    try {
      const bytes = this.busMaster.readPhysical(this.currentPc, sizeBytes);
      return {
        success: true,
        address: this.currentPc,
        sizeBytes,
        bytes,
      };
    } catch (err: unknown) {
      this.runState = Frt64CoreRunState.FAULT;
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        address: this.currentPc,
        sizeBytes,
        fault: message,
      };
    }
  }

  step(): ExecutionStepResult {
    if (this.runState === Frt64CoreRunState.HALTED) {
      return {executed: false, state: this.runState, reason: 'HALTED'};
    }
    if (this.runState === Frt64CoreRunState.FAULT) {
      return {executed: false, state: this.runState, reason: 'FAULT'};
    }

    const fetched = this.fetchInstruction(4);
    if (!fetched.success) {
      return {
        executed: false,
        state: this.runState,
        reason: 'FAULT',
        fetched,
      };
    }

    // No fake ISA simulation or instruction interpreter.
    // Execution engine must be attached for actual architectural instruction execution.
    return {
      executed: false,
      state: this.runState,
      reason: 'NO_EXECUTION_ENGINE_ATTACHED',
      fetched,
    };
  }
}

export class Frt64CpuBoundary implements IFrt64CpuBoundary {
  private readonly cores: Frt64CoreBoundary[] = [];
  readonly defaultFamily: Frt64ExecutionFamily;

  constructor(config: Frt64TopologyConfig) {
    if (config.coreCount <= 0) {
      throw new Error(`FRT64 coreCount must be at least 1, received: ${config.coreCount}`);
    }
    this.defaultFamily = config.defaultFamily;

    const clusters = Math.max(1, config.clusters ?? 1);
    const coresPerCluster = Math.ceil(config.coreCount / clusters);

    for (let i = 0; i < config.coreCount; i++) {
      const clusterId = Math.floor(i / coresPerCluster);
      this.cores.push(
        new Frt64CoreBoundary({
          coreId: i,
          clusterId,
          initialFamily: config.defaultFamily,
          resetVector: config.defaultResetVector,
        })
      );
    }
  }

  get coreCount(): number {
    return this.cores.length;
  }

  getCore(coreId: number): IFrt64CoreBoundary | undefined {
    return this.cores[coreId];
  }

  getAllCores(): readonly IFrt64CoreBoundary[] {
    return this.cores;
  }

  attachBusMaster(bus: IFrt64BusMaster): void {
    for (const core of this.cores) {
      core.attachBusMaster(bus);
    }
  }

  setResetVectorAll(vector: Address64): void {
    for (const core of this.cores) {
      core.setResetVector(vector);
    }
  }

  resetAll(vector?: Address64): void {
    for (const core of this.cores) {
      core.reset(vector);
    }
  }

  haltAll(): void {
    for (const core of this.cores) {
      core.halt();
    }
  }

  resumeAll(): void {
    for (const core of this.cores) {
      core.resume();
    }
  }

  signalGlobalInterrupt(irqVector: number): void {
    for (const core of this.cores) {
      core.signalInterrupt(irqVector);
    }
  }
}
