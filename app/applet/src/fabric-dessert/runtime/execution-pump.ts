import {IFrt64CpuBoundary} from '../arch/frt64/boundary';
import {ExecutionStepResult, Frt64CoreRunState} from '../arch/frt64/types';

export interface ExecutionPumpConfig {
  /** Maximum number of instructions to execute per batch before yielding to host event loop */
  readonly batchSize?: number;
  /** Milliseconds delay between batch ticks (0 for immediate macro-task queue) */
  readonly tickIntervalMs?: number;
}

export interface IExecutionPump {
  readonly isRunning: boolean;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  reset(): void;
  step(maxInstructions?: number): ExecutionStepResult[];
  dispose(): void;
}

/**
 * Fabric Dessert Runtime Execution Pump.
 *
 * Drives bounded instruction batches across active RUNNING CPU cores.
 * Yields periodically to the browser/host event loop via setTimeout, preventing main-thread lockups.
 * Preserves the parked-core contract for secondary cores.
 * Pure TypeScript with zero DOM or Angular dependencies.
 */
export class ExecutionPump implements IExecutionPump {
  private running = false;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly batchSize: number;
  private readonly tickIntervalMs: number;
  private readonly cpuBoundary: IFrt64CpuBoundary;

  constructor(cpuBoundary: IFrt64CpuBoundary, config?: ExecutionPumpConfig) {
    this.cpuBoundary = cpuBoundary;
    this.batchSize = config?.batchSize ?? 1000;
    this.tickIntervalMs = config?.tickIntervalMs ?? 0;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextTick();
  }

  pause(): void {
    this.running = false;
    this.clearScheduledTick();
  }

  resume(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextTick();
  }

  stop(): void {
    this.running = false;
    this.clearScheduledTick();
  }

  reset(): void {
    this.running = false;
    this.clearScheduledTick();
  }

  dispose(): void {
    this.stop();
  }

  /**
   * Deterministic synchronous execution of up to `maxInstructions` on all currently RUNNING cores.
   * Useful for testing, single-stepping, and debugging.
   */
  step(maxInstructions = 1): ExecutionStepResult[] {
    const results: ExecutionStepResult[] = [];
    const cores = this.cpuBoundary.getAllCores();

    for (const core of cores) {
      if (core.getStatus().runState !== Frt64CoreRunState.RUNNING) {
        continue;
      }

      for (let i = 0; i < maxInstructions; i++) {
        if (core.getStatus().runState !== Frt64CoreRunState.RUNNING) {
          break;
        }
        const res = core.step();
        results.push(res);
        if (!res.executed || res.state !== Frt64CoreRunState.RUNNING) {
          break;
        }
      }
    }

    return results;
  }

  private scheduleNextTick(): void {
    if (!this.running || this.timerHandle !== null) {
      return;
    }

    this.timerHandle = setTimeout(() => {
      this.timerHandle = null;
      this.runBatchTick();
    }, this.tickIntervalMs);
  }

  private clearScheduledTick(): void {
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private runBatchTick(): void {
    if (!this.running) {
      return;
    }

    let anyCoreRan = false;
    let anyCoreStillRunning = false;

    const cores = this.cpuBoundary.getAllCores();
    for (const core of cores) {
      if (core.getStatus().runState !== Frt64CoreRunState.RUNNING) {
        continue;
      }

      const batch = core.executeBatch(this.batchSize);
      if (batch.instructionsExecuted > 0) {
        anyCoreRan = true;
      }

      if (core.getStatus().runState === Frt64CoreRunState.RUNNING) {
        anyCoreStillRunning = true;
      }
    }

    // Schedule next tick if execution is active and cores remain runnable
    if (this.running && (anyCoreStillRunning || anyCoreRan)) {
      this.scheduleNextTick();
    } else {
      this.running = false;
    }
  }
}
