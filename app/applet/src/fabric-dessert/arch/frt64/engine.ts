import {Address64} from '../../types';
import {Frt64CoreRunState, Frt64ExecutionFamily} from './types';

export type ExecutionStepReason =
  | 'OK'
  | 'NO_EXECUTION_ENGINE_ATTACHED'
  | 'PARKED'
  | 'HALTED'
  | 'FAULT'
  | 'UNSUPPORTED_EXECUTION_FAMILY'
  | 'INVALID_INSTRUCTION'
  | 'UNSUPPORTED_INSTRUCTION'
  | 'MEMORY_FAULT'
  | 'PAUSED'
  | 'RESET';

export interface BoundedBatchResult {
  instructionsExecuted: number;
  cyclesExecuted: bigint;
  finalState: Frt64CoreRunState;
  lastPc: Address64;
  stoppedReason?: ExecutionStepReason;
  fault?: string;
}

export interface EngineExecutionResult {
  executed: boolean;
  state: Frt64CoreRunState;
  reason: ExecutionStepReason;
  pc: Address64;
  cyclesExecuted: bigint;
  opcode?: number;
  fault?: string;
  disassembly?: string;
}

/**
 * Common CPU Execution Engine Interface.
 *
 * Exposes core CPU state, register access, step execution, bounded batch execution,
 * and lifecycle controls appropriate to the active architecture.
 */
export interface IFrt64ExecutionEngine {
  readonly family: Frt64ExecutionFamily;
  readonly coreId: number;
  readonly isRunning: boolean;

  getProgramCounter(): Address64;
  setProgramCounter(pc: Address64): void;
  getRegister(nameOrIndex: string | number): bigint;
  setRegister(nameOrIndex: string | number, value: bigint): void;
  getStateSnapshot(): Record<string, unknown>;

  step(): EngineExecutionResult;
  executeBatch(maxInstructions: number): BoundedBatchResult;

  reset(entryVector: Address64): void;
  halt(): void;
  pause(): void;
  resume(): void;
  dispose(): void;
}

/**
 * Fallback engine for declared but unattached execution families.
 * Truthfully reports that the selected family does not have an active execution backend.
 */
export class UnsupportedExecutionEngine implements IFrt64ExecutionEngine {
  readonly family: Frt64ExecutionFamily;
  readonly coreId: number;
  private pc: Address64 = 0n;
  private state: Frt64CoreRunState = Frt64CoreRunState.FAULT;

  constructor(family: Frt64ExecutionFamily, coreId: number, initialPc: Address64 = 0n) {
    this.family = family;
    this.coreId = coreId;
    this.pc = initialPc;
  }

  get isRunning(): boolean {
    return false;
  }

  getProgramCounter(): Address64 {
    return this.pc;
  }

  setProgramCounter(pc: Address64): void {
    this.pc = pc;
  }

  getRegister(_nameOrIndex: string | number): bigint {
    return 0n;
  }

  setRegister(_nameOrIndex: string | number, _value: bigint): void {
    // Unsupported engine does not store registers
  }

  getStateSnapshot(): Record<string, unknown> {
    return {
      family: this.family,
      coreId: this.coreId,
      supported: false,
      status: 'UNSUPPORTED_EXECUTION_FAMILY',
    };
  }

  step(): EngineExecutionResult {
    return {
      executed: false,
      state: Frt64CoreRunState.FAULT,
      reason: 'UNSUPPORTED_EXECUTION_FAMILY',
      pc: this.pc,
      cyclesExecuted: 0n,
      fault: `Execution family ${this.family} is declared in the architecture interface but does not have an active execution backend implemented in this milestone.`,
    };
  }

  executeBatch(_maxInstructions: number): BoundedBatchResult {
    return {
      instructionsExecuted: 0,
      cyclesExecuted: 0n,
      finalState: Frt64CoreRunState.FAULT,
      lastPc: this.pc,
      stoppedReason: 'UNSUPPORTED_EXECUTION_FAMILY',
      fault: `Execution family ${this.family} is unsupported.`,
    };
  }

  reset(entryVector: Address64): void {
    this.pc = entryVector;
    this.state = Frt64CoreRunState.FAULT;
  }

  halt(): void {
    this.state = Frt64CoreRunState.HALTED;
  }

  pause(): void {
    // No-op for unsupported engine
  }

  resume(): void {
    // Cannot resume unsupported engine
  }

  dispose(): void {
    // No resources to release
  }
}
