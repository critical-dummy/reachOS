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
import {
  BoundedBatchResult,
  createExecutionEngine,
  IFrt64ExecutionEngine,
} from './engine';

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
  attachExecutionEngine(engine: IFrt64ExecutionEngine | null): void;
  getExecutionEngine(): IFrt64ExecutionEngine | null;
  getRegister(nameOrIndex: string | number): bigint;
  setRegister(nameOrIndex: string | number, value: bigint): void;
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
  executeBatch(maxInstructions: number): BoundedBatchResult;
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
  attachExecutionEngine(engineFactory?: (core: IFrt64CoreBoundary) => IFrt64ExecutionEngine): void;
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
  private executionEngine: IFrt64ExecutionEngine | null = null;
  private readonly autoAttachEngine: boolean;
  protected busMaster: IFrt64BusMaster | null = null;

  constructor(config: Frt64CoreConfig & {autoAttachEngine?: boolean}) {
    this.coreId = config.coreId;
    this.clusterId = config.clusterId ?? 0;
    this.isPrimary = config.isPrimary ?? (config.coreId === 0);
    this.accessContext = createCpuAccessContext(this.coreId, this.clusterId);
    this.activeFamily = config.initialFamily;
    this.autoAttachEngine = config.autoAttachEngine ?? false;
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

  attachExecutionEngine(engine: IFrt64ExecutionEngine | null): void {
    this.executionEngine = engine;
    if (engine) {
      engine.setProgramCounter(this.currentPc);
    }
  }

  getExecutionEngine(): IFrt64ExecutionEngine | null {
    return this.executionEngine;
  }

  getRegister(nameOrIndex: string | number): bigint {
    return this.executionEngine ? this.executionEngine.getRegister(nameOrIndex) : 0n;
  }

  setRegister(nameOrIndex: string | number, value: bigint): void {
    if (this.executionEngine) {
      this.executionEngine.setRegister(nameOrIndex, value);
    }
  }

  setResetVector(vector: Address64): void {
    assertValidAddress64(vector, 'setResetVector');
    this.currentResetVector = vector;
    if (this.executionEngine) {
      this.executionEngine.reset(vector);
    }
  }

  setProgramCounter(address: Address64): void {
    assertValidAddress64(address, 'setProgramCounter');
    this.currentPc = address;
    if (this.executionEngine) {
      this.executionEngine.setProgramCounter(address);
    }
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
      hasEngine: this.executionEngine !== null,
      architectureSnapshot: this.executionEngine ? this.executionEngine.getStateSnapshot() : undefined,
    };
  }

  getActiveFamily(): Frt64ExecutionFamily {
    return this.activeFamily;
  }

  switchExecutionFamily(targetFamily: Frt64ExecutionFamily): boolean {
    if (this.activeFamily === targetFamily) {
      return true;
    }
    if (targetFamily === Frt64ExecutionFamily.ARM_64 && this.busMaster) {
      this.activeFamily = targetFamily;
      this.executionEngine = createExecutionEngine(
        targetFamily,
        this.coreId,
        this.busMaster,
        this.accessContext,
        this.currentPc
      );
      return true;
    }
    // Architectural boundary: only families with genuine execution backends can be switched to
    return false;
  }

  attachBusMaster(bus: IFrt64BusMaster): void {
    this.busMaster = bus;
    if (this.executionEngine && 'setBusMaster' in this.executionEngine) {
      (this.executionEngine as unknown as {setBusMaster(b: IFrt64BusMaster): void}).setBusMaster(bus);
    }
    if (this.autoAttachEngine && !this.executionEngine) {
      this.executionEngine = createExecutionEngine(
        this.activeFamily,
        this.coreId,
        bus,
        this.accessContext,
        this.currentResetVector
      );
    }
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
    if (this.executionEngine) {
      this.executionEngine.reset(this.currentResetVector);
    }
  }

  halt(): void {
    this.runState = Frt64CoreRunState.HALTED;
    if (this.executionEngine) {
      this.executionEngine.halt();
    }
  }

  pause(): void {
    if (this.runState === Frt64CoreRunState.RUNNING) {
      this.runState = Frt64CoreRunState.PAUSED;
      if (this.executionEngine) {
        this.executionEngine.pause();
      }
    }
  }

  resume(): void {
    if (
      this.runState === Frt64CoreRunState.HALTED ||
      this.runState === Frt64CoreRunState.RESET ||
      this.runState === Frt64CoreRunState.PAUSED
    ) {
      this.runState = Frt64CoreRunState.RUNNING;
      if (this.executionEngine) {
        this.executionEngine.resume();
      }
    }
  }

  park(): void {
    this.runState = Frt64CoreRunState.PARKED;
    if (this.executionEngine) {
      this.executionEngine.pause();
    }
  }

  unpark(entryVector?: Address64): boolean {
    if (this.runState !== Frt64CoreRunState.PARKED) {
      return false;
    }
    if (entryVector !== undefined) {
      assertValidAddress64(entryVector, 'unpark entryVector');
      this.currentResetVector = entryVector;
      this.currentPc = entryVector;
      if (this.executionEngine) {
        this.executionEngine.reset(entryVector);
      }
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
      return {executed: false, state: this.runState, reason: 'PARKED', pc: this.currentPc, cyclesExecuted: this.cyclesExecuted};
    }
    if (this.runState === Frt64CoreRunState.HALTED) {
      return {executed: false, state: this.runState, reason: 'HALTED', pc: this.currentPc, cyclesExecuted: this.cyclesExecuted};
    }
    if (this.runState === Frt64CoreRunState.FAULT) {
      return {executed: false, state: this.runState, reason: 'FAULT', pc: this.currentPc, cyclesExecuted: this.cyclesExecuted};
    }

    if (!this.executionEngine) {
      return {
        executed: false,
        state: this.runState,
        reason: 'NO_EXECUTION_ENGINE_ATTACHED',
      };
    }

    const res = this.executionEngine.step();
    this.runState = res.state;
    if (res.pc !== undefined) {
      this.currentPc = res.pc;
    }
    if (res.cyclesExecuted !== undefined) {
      this.cyclesExecuted = res.cyclesExecuted;
    }

    return {
      executed: res.executed,
      state: this.runState,
      reason: res.reason,
      cyclesExecuted: this.cyclesExecuted,
      pc: this.currentPc,
      opcode: res.opcode,
      fault: res.fault,
      disassembly: res.disassembly,
    };
  }

  executeBatch(maxInstructions: number): BoundedBatchResult {
    if (this.runState === Frt64CoreRunState.PARKED) {
      return {instructionsExecuted: 0, cyclesExecuted: 0n, finalState: this.runState, lastPc: this.currentPc, stoppedReason: 'PARKED'};
    }
    if (this.runState === Frt64CoreRunState.HALTED) {
      return {instructionsExecuted: 0, cyclesExecuted: 0n, finalState: this.runState, lastPc: this.currentPc, stoppedReason: 'HALTED'};
    }
    if (this.runState === Frt64CoreRunState.FAULT) {
      return {instructionsExecuted: 0, cyclesExecuted: 0n, finalState: this.runState, lastPc: this.currentPc, stoppedReason: 'FAULT'};
    }
    if (!this.executionEngine) {
      return {instructionsExecuted: 0, cyclesExecuted: 0n, finalState: this.runState, lastPc: this.currentPc, stoppedReason: 'NO_EXECUTION_ENGINE_ATTACHED'};
    }
    const res = this.executionEngine.executeBatch(maxInstructions);
    this.runState = res.finalState;
    this.currentPc = res.lastPc;
    this.cyclesExecuted += res.cyclesExecuted;
    return res;
  }
}

export class Frt64CpuBoundary implements IFrt64CpuBoundary {
  private readonly cores: Frt64CoreBoundary[] = [];
  readonly primaryCoreId: number;
  readonly defaultFamily: Frt64ExecutionFamily;
  private busMaster: IFrt64BusMaster | null = null;

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
          autoAttachEngine: config.autoAttachEngine,
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
    this.busMaster = bus;
    for (const core of this.cores) {
      core.attachBusMaster(bus);
    }
  }

  attachExecutionEngine(engineFactory?: (core: IFrt64CoreBoundary) => IFrt64ExecutionEngine): void {
    if (!this.busMaster) {
      throw new Error('Cannot attach execution engine before bus master is attached');
    }
    for (const core of this.cores) {
      const engine = engineFactory
        ? engineFactory(core)
        : createExecutionEngine(
            core.getActiveFamily(),
            core.coreId,
            this.busMaster,
            core.accessContext,
            core.resetVector
          );
      core.attachExecutionEngine(engine);
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
