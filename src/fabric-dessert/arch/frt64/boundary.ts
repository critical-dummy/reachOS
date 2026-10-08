import {
  Frt64CoreConfig,
  Frt64CoreRunState,
  Frt64CoreStatus,
  Frt64ExecutionFamily,
  Frt64TopologyConfig,
} from './types';
import {Address64} from '../../types';

export interface IFrt64BusMaster {
  readPhysical(address: Address64, sizeBytes: number): Uint8Array;
  writePhysical(address: Address64, data: Uint8Array): void;
}

export interface IFrt64CoreBoundary {
  readonly coreId: number;
  readonly clusterId: number;
  getStatus(): Frt64CoreStatus;
  getActiveFamily(): Frt64ExecutionFamily;
  switchExecutionFamily(targetFamily: Frt64ExecutionFamily): boolean;
  attachBusMaster(bus: IFrt64BusMaster): void;
  reset(): void;
  halt(): void;
  resume(): void;
  signalInterrupt(irqVector: number): void;
}

export interface IFrt64CpuBoundary {
  readonly coreCount: number;
  readonly defaultFamily: Frt64ExecutionFamily;
  getCore(coreId: number): IFrt64CoreBoundary | undefined;
  getAllCores(): readonly IFrt64CoreBoundary[];
  attachBusMaster(bus: IFrt64BusMaster): void;
  resetAll(): void;
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
  protected busMaster: IFrt64BusMaster | null = null;

  constructor(config: Frt64CoreConfig) {
    this.coreId = config.coreId;
    this.clusterId = config.clusterId ?? 0;
    this.activeFamily = config.initialFamily;
  }

  getStatus(): Frt64CoreStatus {
    return {
      coreId: this.coreId,
      runState: this.runState,
      activeFamily: this.activeFamily,
      cyclesExecuted: this.cyclesExecuted,
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

  reset(): void {
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

  resetAll(): void {
    for (const core of this.cores) {
      core.reset();
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
