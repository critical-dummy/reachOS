import {Injectable} from '@angular/core';
import {
  CanvasBackend,
  createFabricDessertInstance,
  IFabricDessertInstance,
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
  private canvasBackend: CanvasBackend | null = null;

  constructor() {
    this.instance = createFabricDessertInstance();
    this.instance.initialize();
  }

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvasBackend = new CanvasBackend(canvas);
    this.instance.board.displayDevice.systemRenderer.attachOutputBackend(this.canvasBackend);
  }
}
