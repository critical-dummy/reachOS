import {IDevice} from '../device/types';

export const DISPLAY_WIDTH = 1080;
export const DISPLAY_HEIGHT = 2424;
export const BYTES_PER_PIXEL = 4; // RGBA8888
export const DISPLAY_STRIDE_BYTES = DISPLAY_WIDTH * BYTES_PER_PIXEL; // 4320
export const FRAMEBUFFER_SIZE_BYTES = DISPLAY_WIDTH * DISPLAY_HEIGHT * BYTES_PER_PIXEL; // 10,471,680 bytes

export enum PixelFormat {
  RGBA8888 = 'RGBA8888',
}

export interface IFramebuffer {
  readonly width: number;
  readonly height: number;
  readonly strideBytes: number;
  readonly sizeBytes: number;
  readonly pixelFormat: PixelFormat;

  getPixelBuffer(): Uint8ClampedArray;
  readPixel(x: number, y: number): number;
  writePixel(x: number, y: number, r: number, g: number, b: number, a: number): void;
  readBytes(offset: number, length: number): Uint8Array;
  writeBytes(offset: number, data: Uint8Array): void;

  markDirty(): void;
  isDirty(): boolean;
  clearDirty(): void;
  clear(r?: number, g?: number, b?: number, a?: number): void;
}

export interface IDisplayOutputBackend {
  readonly targetWidth: number;
  readonly targetHeight: number;
  present(framebuffer: IFramebuffer): void;
}

export interface ISystemRenderer {
  readonly framebuffer: IFramebuffer;
  attachOutputBackend(backend: IDisplayOutputBackend): void;
  detachOutputBackend(): void;
  getAttachedBackend(): IDisplayOutputBackend | null;
  renderFrame(): boolean;
  flush(): void;
}

export interface IFabricDessertDisplayDevice extends IDevice {
  readonly framebuffer: IFramebuffer;
  readonly systemRenderer: ISystemRenderer;
  flush(): void;
}
