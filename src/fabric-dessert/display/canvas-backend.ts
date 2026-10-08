import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  IDisplayOutputBackend,
  IFramebuffer,
} from './types';

/**
 * Browser-specific canvas adapter.
 * Performs deterministic 1:1 pixel blitting from the platform framebuffer
 * to the host HTMLCanvasElement without scaling or interpolation.
 */
export class CanvasBackend implements IDisplayOutputBackend {
  readonly targetWidth: number;
  readonly targetHeight: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly imageData: ImageData;

  constructor(canvas: HTMLCanvasElement) {
    this.targetWidth = DISPLAY_WIDTH;
    this.targetHeight = DISPLAY_HEIGHT;

    if (canvas.width !== DISPLAY_WIDTH || canvas.height !== DISPLAY_HEIGHT) {
      throw new Error(
        `Canvas dimension mismatch: expected ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}, got ${canvas.width}x${canvas.height}`
      );
    }

    this.canvas = canvas;
    const context = this.canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: false,
    });

    if (!context) {
      throw new Error('Failed to acquire 2D rendering context from canvas.');
    }

    this.ctx = context;
    this.ctx.imageSmoothingEnabled = false;
    this.imageData = this.ctx.createImageData(this.targetWidth, this.targetHeight);
  }

  present(framebuffer: IFramebuffer): void {
    const srcBuffer = framebuffer.getPixelBuffer();
    this.imageData.data.set(srcBuffer);
    this.ctx.putImageData(this.imageData, 0, 0);
  }
}
