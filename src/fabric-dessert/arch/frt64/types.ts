/**
 * FRT64 MultiSupport CPU Architecture boundary definitions.
 * Execution families supported: ARM 32-bit, ARM 64-bit, x86 32-bit, x86 64-bit.
 * This is an external CPU architecture interface contract for Fabric Dessert.
 */

import {Address64} from '../../types';

export enum Frt64ExecutionFamily {
  ARM_32 = 'ARM_32',
  ARM_64 = 'ARM_64',
  X86_32 = 'X86_32',
  X86_64 = 'X86_64',
}

export enum Frt64CoreRunState {
  RESET = 'RESET',
  PARKED = 'PARKED',
  HALTED = 'HALTED',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  FAULT = 'FAULT',
}

export interface Frt64CoreConfig {
  coreId: number;
  clusterId?: number;
  initialFamily: Frt64ExecutionFamily;
  frequencyHz?: number;
  resetVector?: Address64;
  isPrimary?: boolean;
}

export interface Frt64TopologyConfig {
  coreCount: number;
  clusters?: number;
  defaultFamily: Frt64ExecutionFamily;
  defaultResetVector?: Address64;
  primaryCoreId?: number;
}

export interface Frt64CoreStatus {
  coreId: number;
  isPrimary: boolean;
  runState: Frt64CoreRunState;
  activeFamily: Frt64ExecutionFamily;
  cyclesExecuted: bigint;
  pc: Address64;
  resetVector: Address64;
}

export interface InstructionFetchResult {
  success: boolean;
  address: Address64;
  sizeBytes: number;
  bytes?: Uint8Array;
  fault?: string;
}

export interface ExecutionStepResult {
  executed: boolean;
  state: Frt64CoreRunState;
  reason: 'NO_EXECUTION_ENGINE_ATTACHED' | 'PARKED' | 'HALTED' | 'FAULT';
}

