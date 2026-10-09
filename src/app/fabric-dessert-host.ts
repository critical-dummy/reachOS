import {Injectable, signal} from '@angular/core';
import {
  CanvasBackend,
  createFabricDessertInstance,
  IFabricDessertInstance,
  RuntimeLifecycleState,
} from '../fabric-dessert';

/**
 * Host integration service connecting the browser/Angular runtime to Fabric Dessert.
 * Angular is strictly an execution host; it does not define or alter the hardware model.
 */
@Injectable({
  providedIn: 'root',
})
export class FabricDessertHost {
  readonly instance: IFabricDessertInstance;
  readonly state = signal<RuntimeLifecycleState>(RuntimeLifecycleState.UNINITIALIZED);
  private canvasBackend: CanvasBackend | null = null;

  constructor() {
    this.instance = createFabricDessertInstance();
    this.instance.onStateChange((_prev, next) => {
      this.state.set(next);
    });
    this.instance.initialize();
    this.state.set(this.instance.getState());
  }

  attachCanvas(canvas: HTMLCanvasElement): void {
    if (this.canvasBackend) {
      return;
    }
    this.canvasBackend = new CanvasBackend(canvas);
    this.instance.board.displayDevice.systemRenderer.attachOutputBackend(this.canvasBackend);

    // Auto-boot virtual device immediately upon client canvas attachment
    if (this.instance.getState() === RuntimeLifecycleState.READY) {
      this.instance.start();
    }
  }

  start(): void {
    if (this.instance.getState() === RuntimeLifecycleState.READY) {
      this.instance.start();
    } else if (this.instance.getState() === RuntimeLifecycleState.PAUSED) {
      this.instance.resume();
    }
  }

  pause(): void {
    if (this.instance.getState() === RuntimeLifecycleState.RUNNING) {
      this.instance.pause();
    }
  }

  resume(): void {
    if (this.instance.getState() === RuntimeLifecycleState.PAUSED) {
      this.instance.resume();
    }
  }

  stop(): void {
    if (
      this.instance.getState() === RuntimeLifecycleState.RUNNING ||
      this.instance.getState() === RuntimeLifecycleState.PAUSED
    ) {
      this.instance.stop();
    }
  }

  restart(): void {
    const currentState = this.instance.getState();
    if (currentState === RuntimeLifecycleState.STOPPED) {
      this.instance.initialize();
      this.instance.start();
    } else {
      this.instance.reset();
      this.instance.start();
    }
  }

  powerToggle(): void {
    const currentState = this.instance.getState();
    if (
      currentState === RuntimeLifecycleState.RUNNING ||
      currentState === RuntimeLifecycleState.PAUSED
    ) {
      this.stop();
    } else if (currentState === RuntimeLifecycleState.STOPPED) {
      this.instance.initialize();
      this.start();
    } else if (currentState === RuntimeLifecycleState.READY) {
      this.start();
    }
  }
}

