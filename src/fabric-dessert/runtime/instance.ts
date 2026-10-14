import {
  DEFAULT_FABRIC_DESSERT_CONFIG,
  FabricDessertBoardConfig,
} from '../board/types';
import {FabricDessertBoard, IFabricDessertBoard} from '../board/board';
import {IFrt64CpuBoundary} from '../arch/frt64/boundary';
import {IPhysicalAddressSpace} from '../memory/address-space';
import {IDeviceBus} from '../device/bus';
import {LifecycleStateChangeListener, RuntimeLifecycleState} from './lifecycle';

import {IExecutionPump, ExecutionPump} from './execution-pump';

export interface IFabricDessertInstance {
  readonly board: IFabricDessertBoard;
  readonly cpu: IFrt64CpuBoundary;
  readonly memory: IPhysicalAddressSpace;
  readonly deviceBus: IDeviceBus;
  readonly executionPump: IExecutionPump;

  getState(): RuntimeLifecycleState;
  onStateChange(listener: LifecycleStateChangeListener): () => void;

  initialize(): void;
  start(): void;
  pause(): void;
  resume(): void;
  stop(): void;
  reset(): void;
  attachExecutionEngine(family?: import('../arch/frt64/types').Frt64ExecutionFamily): void;
}

export class FabricDessertInstance implements IFabricDessertInstance {
  readonly board: IFabricDessertBoard;
  readonly executionPump: IExecutionPump;
  private state: RuntimeLifecycleState = RuntimeLifecycleState.UNINITIALIZED;
  private readonly stateListeners = new Set<LifecycleStateChangeListener>();

  constructor(config: FabricDessertBoardConfig) {
    this.board = new FabricDessertBoard(config);
    this.executionPump = new ExecutionPump(this.board.cpuBoundary);
    this.transitionTo(RuntimeLifecycleState.CONFIGURED);
  }

  get cpu(): IFrt64CpuBoundary {
    return this.board.cpuBoundary;
  }

  get memory(): IPhysicalAddressSpace {
    return this.board.addressSpace;
  }

  get deviceBus(): IDeviceBus {
    return this.board.deviceBus;
  }

  attachExecutionEngine(family?: import('../arch/frt64/types').Frt64ExecutionFamily): void {
    this.board.attachExecutionEngine(family);
  }

  getState(): RuntimeLifecycleState {
    return this.state;
  }

  onStateChange(listener: LifecycleStateChangeListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private transitionTo(newState: RuntimeLifecycleState): void {
    if (this.state === newState) return;
    const previous = this.state;
    this.state = newState;
    for (const listener of this.stateListeners) {
      listener(previous, newState);
    }
  }

  initialize(): void {
    if (
      this.state !== RuntimeLifecycleState.CONFIGURED &&
      this.state !== RuntimeLifecycleState.STOPPED
    ) {
      throw new Error(
        `Cannot initialize Fabric Dessert from state "${this.state}". Expected CONFIGURED or STOPPED.`
      );
    }
    this.executionPump.reset();
    this.board.reset();
    this.transitionTo(RuntimeLifecycleState.READY);
  }

  start(): void {
    if (this.state !== RuntimeLifecycleState.READY) {
      if (this.state === RuntimeLifecycleState.PAUSED) {
        this.resume();
        return;
      }
      throw new Error(
        `Cannot start Fabric Dessert from state "${this.state}". Instance must be READY.`
      );
    }
    // Startup policy: only the primary boot CPU enters the running boot path
    this.board.start();
    this.executionPump.start();
    this.transitionTo(RuntimeLifecycleState.RUNNING);
  }

  pause(): void {
    if (this.state !== RuntimeLifecycleState.RUNNING) {
      throw new Error(`Cannot pause Fabric Dessert when in state "${this.state}".`);
    }
    this.executionPump.pause();
    this.board.pause();
    this.transitionTo(RuntimeLifecycleState.PAUSED);
  }

  resume(): void {
    if (this.state !== RuntimeLifecycleState.PAUSED) {
      throw new Error(`Cannot resume Fabric Dessert when in state "${this.state}".`);
    }
    this.board.resume();
    this.executionPump.resume();
    this.transitionTo(RuntimeLifecycleState.RUNNING);
  }

  stop(): void {
    this.executionPump.stop();
    this.board.powerOff();
    this.transitionTo(RuntimeLifecycleState.STOPPED);
  }

  reset(): void {
    this.executionPump.reset();
    this.board.reset();
    this.transitionTo(RuntimeLifecycleState.READY);
  }
}

export function createFabricDessertInstance(
  config?: Partial<FabricDessertBoardConfig>
): IFabricDessertInstance {
  const mergedConfig: FabricDessertBoardConfig = {
    ...DEFAULT_FABRIC_DESSERT_CONFIG,
    ...config,
    cpuTopology: {
      ...DEFAULT_FABRIC_DESSERT_CONFIG.cpuTopology,
      ...(config?.cpuTopology ?? {}),
    },
    memoryLayout: {
      ...DEFAULT_FABRIC_DESSERT_CONFIG.memoryLayout,
      ...(config?.memoryLayout ?? {}),
    },
    bootContract: {
      ...DEFAULT_FABRIC_DESSERT_CONFIG.bootContract,
      ...(config?.bootContract ?? {}),
    },
  };

  return new FabricDessertInstance(mergedConfig);
}
