export enum RuntimeLifecycleState {
  UNINITIALIZED = 'UNINITIALIZED',
  CONFIGURED = 'CONFIGURED',
  READY = 'READY',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
}

export type LifecycleStateChangeListener = (
  previous: RuntimeLifecycleState,
  current: RuntimeLifecycleState
) => void;
