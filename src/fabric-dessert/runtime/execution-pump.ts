/**
 * Fabric Dessert Execution Pump.
 * Provides a bounded runtime execution loop that pumps CPU instruction cycles
 * against the board bus and devices without blocking the host browser/runtime event loop.
 */

import {IFrt64CpuBoundary} from '../arch/frt64/boundary';
import {Frt64CoreRunState} from '../arch/frt64/types';

export interface ExecutionPumpOptions {
  /** Maximum number of instructions to execute per core in a single slice */
  instructionsPerSlice?: number;
  /** Milliseconds delay between slices when running via timer */
  sliceIntervalMs?: number;
  /** Callback fired after each slice execution */
  onSliceExecuted?: (instructionsExecuted: number, cyclesExecuted: bigint) => void;
  /** Callback fired when a core enters HALTED state */
  onCoreHalted?: (coreId: number) => void;
  /** Callback fired when a core enters FAULT state */
  onCoreFault?: (coreId: number, fault?: string) => void;
}

export interface ExecutionPumpMetrics {
  active: boolean;
  paused: boolean;
  totalInstructionsExecuted: number;
  totalCyclesExecuted: bigint;
  slicesPumped: number;
}

export interface IExecutionPump {
  readonly cpu: IFrt64CpuBoundary;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  reset(): void;
  pumpSlice(maxInstructions?: number): number;
  isRunning(): boolean;
  getMetrics(): ExecutionPumpMetrics;
}

export class ExecutionPump implements IExecutionPump {
  readonly cpu: IFrt64CpuBoundary;
  private readonly instructionsPerSlice: number;
  private readonly sliceIntervalMs: number;
  private readonly onSliceExecuted?: (instructions: number, cycles: bigint) => void;
  private readonly onCoreHalted?: (coreId: number) => void;
  private readonly onCoreFault?: (coreId: number, fault?: string) => void;

  private active = false;
  private paused = false;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private rafHandle: number | null = null;

  private totalInstructions = 0;
  private totalCycles = 0n;
  private slicesPumped = 0;
  private readonly unsubscribeWakeListener?: () => void;

  constructor(cpu: IFrt64CpuBoundary, options?: ExecutionPumpOptions) {
    this.cpu = cpu;
    this.instructionsPerSlice = Math.max(1, options?.instructionsPerSlice ?? 500);
    this.sliceIntervalMs = Math.max(0, options?.sliceIntervalMs ?? 16);
    this.onSliceExecuted = options?.onSliceExecuted;
    this.onCoreHalted = options?.onCoreHalted;
    this.onCoreFault = options?.onCoreFault;

    // Connect wake listener so WFE/WFI wakeups and IRQs schedule execution again
    if (this.cpu && 'addWakeListener' in this.cpu) {
      this.unsubscribeWakeListener = this.cpu.addWakeListener(() => {
        this.onCpuWake();
      });
    }
  }

  isRunning(): boolean {
    return this.active && !this.paused;
  }

  getMetrics(): ExecutionPumpMetrics {
    return {
      active: this.active,
      paused: this.paused,
      totalInstructionsExecuted: this.totalInstructions,
      totalCyclesExecuted: this.totalCycles,
      slicesPumped: this.slicesPumped,
    };
  }

  start(): void {
    if (this.active && !this.paused) {
      return;
    }
    this.active = true;
    this.paused = false;
    this.scheduleNextSlice();
  }

  pause(): void {
    if (!this.active) return;
    this.paused = true;
    this.cancelScheduled();
  }

  resume(): void {
    if (!this.active) {
      this.start();
      return;
    }
    if (this.paused) {
      this.paused = false;
      this.scheduleNextSlice();
    }
  }

  stop(): void {
    this.active = false;
    this.paused = false;
    this.cancelScheduled();
  }

  reset(): void {
    this.stop();
    this.totalInstructions = 0;
    this.totalCycles = 0n;
    this.slicesPumped = 0;
  }

  pumpSlice(maxInstructions?: number): number {
    const limit = maxInstructions ?? this.instructionsPerSlice;
    let sliceInstructions = 0;
    let sliceCycles = 0n;

    const cores = this.cpu.getAllCores();
    for (const core of cores) {
      const status = core.getStatus();
      if (
        status.runState === Frt64CoreRunState.RUNNING ||
        status.runState === Frt64CoreRunState.RESET
      ) {
        const batch = core.executeBatch(limit);
        sliceInstructions += batch.instructionsExecuted;
        sliceCycles += batch.cyclesExecuted;

        if (batch.finalState === Frt64CoreRunState.HALTED) {
          this.onCoreHalted?.(core.coreId);
        } else if (batch.finalState === Frt64CoreRunState.FAULT) {
          this.onCoreFault?.(core.coreId, batch.stoppedReason);
        }
      }
    }

    this.totalInstructions += sliceInstructions;
    this.totalCycles += sliceCycles;
    this.slicesPumped++;

    if (sliceInstructions > 0 || sliceCycles > 0n) {
      this.onSliceExecuted?.(sliceInstructions, sliceCycles);
    }

    return sliceInstructions;
  }

  private onCpuWake(): void {
    // Paused and stopped pumps must not resume accidentally because of an IRQ or event
    if (!this.active || this.paused) {
      return;
    }
    this.scheduleNextSlice();
  }

  private scheduleNextSlice(): void {
    if (!this.active || this.paused) return;
    // Avoid duplicate timers or animation frames when several events arrive
    if (this.timerHandle !== null || this.rafHandle !== null) {
      return;
    }

    const run = () => {
      this.timerHandle = null;
      this.rafHandle = null;
      if (!this.active || this.paused) return;
      this.pumpSlice();

      // Check if any core remains ready to execute
      const anyRunning = this.cpu.getAllCores().some((core) => {
        const s = core.getStatus().runState;
        return s === Frt64CoreRunState.RUNNING || s === Frt64CoreRunState.RESET;
      });

      if (anyRunning && this.active && !this.paused) {
        this.scheduleNextSlice();
      }
    };

    if (typeof requestAnimationFrame === 'function' && typeof window !== 'undefined') {
      this.rafHandle = requestAnimationFrame(run);
    } else {
      this.timerHandle = setTimeout(run, this.sliceIntervalMs);
    }
  }

  private cancelScheduled(): void {
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.rafHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }
}
