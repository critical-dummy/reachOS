import {
  ExecutionStepResult,
  Frt64CoreConfig,
  Frt64CoreRunState,
  Frt64CoreStatus,
  Frt64ExecutionFamily,
  Frt64TopologyConfig,
  InstructionFetchResult,
} from './types';
import {Address64, assertValidAddress64} from '../../types';
import {
  CpuAccessContext,
  createCpuAccessContext,
  PhysicalAccessContext,
} from '../../memory/access-context';

export interface IFrt64BusMaster {
  readPhysical(address: Address64, sizeBytes: number, context?: PhysicalAccessContext): Uint8Array;
  writePhysical(address: Address64, data: Uint8Array, context?: PhysicalAccessContext): void;
  fetchInstructionPhysical(address: Address64, sizeBytes: number, context?: PhysicalAccessContext): Uint8Array;
}

export interface IFrt64CoreBoundary {
  readonly coreId: number;
  readonly clusterId: number;
  readonly isPrimary: boolean;
  readonly pc: Address64;
  readonly resetVector: Address64;
  readonly accessContext: CpuAccessContext;
  getStatus(): Frt64CoreStatus;
  getActiveFamily(): Frt64ExecutionFamily;
  switchExecutionFamily(targetFamily: Frt64ExecutionFamily): boolean;
  attachBusMaster(bus: IFrt64BusMaster): void;
  setResetVector(vector: Address64): void;
  setProgramCounter(address: Address64): void;
  reset(vector?: Address64): void;
  halt(): void;
  pause(): void;
  resume(): void;
  park(): void;
  unpark(entryVector?: Address64): boolean;
  signalInterrupt(irqVector: number): void;
  readPhysical(address: Address64, sizeBytes: number): Uint8Array;
  writePhysical(address: Address64, data: Uint8Array): void;
  fetchInstructionBytes(sizeBytes: number): InstructionFetchResult;
  step(): ExecutionStepResult;
}

export interface IFrt64CpuBoundary {
  readonly coreCount: number;
  readonly primaryCoreId: number;
  readonly defaultFamily: Frt64ExecutionFamily;
  getCore(coreId: number): IFrt64CoreBoundary | undefined;
  getPrimaryCore(): IFrt64CoreBoundary;
  getSecondaryCores(): readonly IFrt64CoreBoundary[];
  getAllCores(): readonly IFrt64CoreBoundary[];
  attachBusMaster(bus: IFrt64BusMaster): void;
  setResetVectorAll(vector: Address64): void;
  resetAll(vector?: Address64): void;
  haltAll(): void;
  pauseRunningCores(): void;
  resumePausedCores(): void;
  resumePrimary(): void;
  resumeAll(): void;
  releaseSecondaryCore(coreId: number, entryVector?: Address64): boolean;
  signalGlobalInterrupt(irqVector: number): void;
}

export class Frt64CoreBoundary implements IFrt64CoreBoundary {
  readonly coreId: number;
  readonly clusterId: number;
  readonly isPrimary: boolean;
  readonly accessContext: CpuAccessContext;
  private runState: Frt64CoreRunState;
  private activeFamily: Frt64ExecutionFamily;
  private cyclesExecuted = 0n;
  private currentPc: Address64;
  private currentResetVector: Address64;
  protected busMaster: IFrt64BusMaster | null = null;

  constructor(config: Frt64CoreConfig) {
    this.coreId = config.coreId;
    this.clusterId = config.clusterId ?? 0;
    this.isPrimary = config.isPrimary ?? (config.coreId === 0);
    this.accessContext = createCpuAccessContext(this.coreId, this.clusterId);
    this.activeFamily = config.initialFamily;
    const initialReset = config.resetVector ?? 0n;
    assertValidAddress64(initialReset, 'core resetVector');
    this.currentResetVector = initialReset;
    this.currentPc = this.currentResetVector;
    this.runState = this.isPrimary ? Frt64CoreRunState.RESET : Frt64CoreRunState.PARKED;
  }

  get pc(): Address64 {
    return this.currentPc;
  }

  get resetVector(): Address64 {
    return this.currentResetVector;
  }

  setResetVector(vector: Address64): void {
    assertValidAddress64(vector, 'setResetVector');
    this.currentResetVector = vector;
  }

  setProgramCounter(address: Address64): void {
    assertValidAddress64(address, 'setProgramCounter');
    this.currentPc = address;
  }

  getStatus(): Frt64CoreStatus {
    return {
      coreId: this.coreId,
      isPrimary: this.isPrimary,
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
    // Architectural boundary: FRT64 execution engine is external and not yet attached.
    // We do NOT pretend that runtime execution-family switching is implemented.
    return false;
  }

  attachBusMaster(bus: IFrt64BusMaster): void {
    this.busMaster = bus;
  }

  reset(vector?: Address64): void {
    if (vector !== undefined) {
      assertValidAddress64(vector, 'core reset vector');
      this.currentResetVector = vector;
    }
    this.currentPc = this.currentResetVector;
    this.cyclesExecuted = 0n;
    // Primary core enters RESET state ready to boot; secondary cores remain PARKED
    this.runState = this.isPrimary ? Frt64CoreRunState.RESET : Frt64CoreRunState.PARKED;
  }

  halt(): void {
    this.runState = Frt64CoreRunState.HALTED;
  }

  pause(): void {
    if (this.runState === Frt64CoreRunState.RUNNING) {
      this.runState = Frt64CoreRunState.PAUSED;
    }
  }

  resume(): void {
    if (
      this.runState === Frt64CoreRunState.HALTED ||
      this.runState === Frt64CoreRunState.RESET ||
      this.runState === Frt64CoreRunState.PAUSED
    ) {
      this.runState = Frt64CoreRunState.RUNNING;
    }
  }

  park(): void {
    this.runState = Frt64CoreRunState.PARKED;
  }

  unpark(entryVector?: Address64): boolean {
    if (this.runState !== Frt64CoreRunState.PARKED) {
      return false;
    }
    if (entryVector !== undefined) {
      assertValidAddress64(entryVector, 'unpark entryVector');
      this.currentResetVector = entryVector;
      this.currentPc = entryVector;
    }
    this.runState = Frt64CoreRunState.RESET;
    return true;
  }

  signalInterrupt(_irqVector: number): void {
    void _irqVector;
  }

  readPhysical(address: Address64, sizeBytes: number): Uint8Array {
    if (!this.busMaster) {
      throw new Error(`NO_BUS_MASTER_ATTACHED: core ${this.coreId}`);
    }
    return this.busMaster.readPhysical(address, sizeBytes, this.accessContext);
  }

  writePhysical(address: Address64, data: Uint8Array): void {
    if (!this.busMaster) {
      throw new Error(`NO_BUS_MASTER_ATTACHED: core ${this.coreId}`);
    }
    this.busMaster.writePhysical(address, data, this.accessContext);
  }

  fetchInstructionBytes(sizeBytes: number): InstructionFetchResult {
    if (sizeBytes <= 0) {
      return {
        success: false,
        address: this.currentPc,
        sizeBytes,
        fault: `Invalid instruction fetch size: ${sizeBytes}`,
      };
    }

    if (!this.busMaster) {
      return {
        success: false,
        address: this.currentPc,
        sizeBytes,
        fault: 'NO_BUS_MASTER_ATTACHED',
      };
    }

    try {
      const bytes = this.busMaster.fetchInstructionPhysical(
        this.currentPc,
        sizeBytes,
        this.accessContext
      );
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
    if (this.runState === Frt64CoreRunState.PARKED) {
      return {executed: false, state: this.runState, reason: 'PARKED'};
    }
    if (this.runState === Frt64CoreRunState.HALTED) {
      return {executed: false, state: this.runState, reason: 'HALTED'};
    }
    if (this.runState === Frt64CoreRunState.FAULT) {
      return {executed: false, state: this.runState, reason: 'FAULT'};
    }

    // No fake ISA simulation or instruction interpreter.
    // Execution engine must be attached for actual architectural instruction execution.
    // Does not assume any instruction byte length.
    return {
      executed: false,
      state: this.runState,
      reason: 'NO_EXECUTION_ENGINE_ATTACHED',
    };
  }
}

export class Frt64CpuBoundary implements IFrt64CpuBoundary {
  private readonly cores: Frt64CoreBoundary[] = [];
  readonly primaryCoreId: number;
  readonly defaultFamily: Frt64ExecutionFamily;

  constructor(config: Frt64TopologyConfig) {
    if (config.coreCount <= 0) {
      throw new Error(`FRT64 coreCount must be at least 1, received: ${config.coreCount}`);
    }
    const primaryId = config.primaryCoreId ?? 0;
    if (primaryId < 0 || primaryId >= config.coreCount) {
      throw new Error(
        `Invalid primaryCoreId ${primaryId}: must be between 0 and ${config.coreCount - 1} for topology with ${config.coreCount} cores`
      );
    }
    this.primaryCoreId = primaryId;
    this.defaultFamily = config.defaultFamily;

    const clusters = Math.max(1, config.clusters ?? 1);
    const coresPerCluster = Math.ceil(config.coreCount / clusters);

    for (let i = 0; i < config.coreCount; i++) {
      const clusterId = Math.floor(i / coresPerCluster);
      this.cores.push(
        new Frt64CoreBoundary({
          coreId: i,
          clusterId,
          isPrimary: i === this.primaryCoreId,
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

  getPrimaryCore(): IFrt64CoreBoundary {
    const primary = this.cores[this.primaryCoreId];
    if (!primary) {
      throw new Error(`Primary core ${this.primaryCoreId} not found in CPU topology`);
    }
    return primary;
  }

  getSecondaryCores(): readonly IFrt64CoreBoundary[] {
    return this.cores.filter((c) => c.coreId !== this.primaryCoreId);
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
    assertValidAddress64(vector, 'setResetVectorAll vector');
    for (const core of this.cores) {
      core.setResetVector(vector);
    }
  }

  resetAll(vector?: Address64): void {
    if (vector !== undefined) {
      assertValidAddress64(vector, 'resetAll vector');
    }
    for (const core of this.cores) {
      core.reset(vector);
    }
  }

  haltAll(): void {
    for (const core of this.cores) {
      core.halt();
    }
  }

  pauseRunningCores(): void {
    for (const core of this.cores) {
      core.pause();
    }
  }

  resumePausedCores(): void {
    for (const core of this.cores) {
      if (core.getStatus().runState === Frt64CoreRunState.PAUSED) {
        core.resume();
      }
    }
  }

  resumePrimary(): void {
    this.getPrimaryCore().resume();
  }

  resumeAll(): void {
    for (const core of this.cores) {
      core.resume();
    }
  }

  releaseSecondaryCore(coreId: number, entryVector?: Address64): boolean {
    if (coreId === this.primaryCoreId) {
      return false; // Primary core cannot be released as a secondary
    }
    const core = this.cores[coreId];
    if (!core) {
      return false;
    }
    return core.unpark(entryVector);
  }

  signalGlobalInterrupt(irqVector: number): void {
    for (const core of this.cores) {
      core.signalInterrupt(irqVector);
    }
  }
}
