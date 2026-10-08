import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  inject,
} from '@angular/core';
import {FabricDessertHost} from './fabric-dessert-host';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly host = inject(FabricDessertHost);

  constructor() {
    afterNextRender(() => {
      const canvasEl = document.querySelector('canvas');
      if (canvasEl instanceof HTMLCanvasElement) {
        this.host.attachCanvas(canvasEl);
      }
    });
  }
}
