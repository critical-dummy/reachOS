/**
 * FRT64 MultiSupport CPU Architecture boundary definitions.
 * Execution families supported: ARM 32-bit, ARM 64-bit, x86 32-bit, x86 64-bit.
 * This is an external CPU architecture interface contract for Fabric Dessert.
 */

export enum Frt64ExecutionFamily {
  ARM_32 = 'ARM_32',
  ARM_64 = 'ARM_64',
  X86_32 = 'X86_32',
  X86_64 = 'X86_64',
}

export enum Frt64CoreRunState {
  RESET = 'RESET',
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
}

export interface Frt64TopologyConfig {
  coreCount: number;
  clusters?: number;
  defaultFamily: Frt64ExecutionFamily;
}

export interface Frt64CoreStatus {
  coreId: number;
  runState: Frt64CoreRunState;
  activeFamily: Frt64ExecutionFamily;
  cyclesExecuted: bigint;
}
