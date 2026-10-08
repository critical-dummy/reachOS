import {
  BYTES_PER_PIXEL,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  IFramebuffer,
  PixelFormat,
} from './types';

export class Framebuffer implements IFramebuffer {
  readonly width: number;
  readonly height: number;
  readonly strideBytes: number;
  readonly sizeBytes: number;
  readonly pixelFormat: PixelFormat = PixelFormat.RGBA8888;

  private readonly buffer: Uint8ClampedArray;
  private dirty = false;

  constructor(width = DISPLAY_WIDTH, height = DISPLAY_HEIGHT) {
    if (width <= 0 || height <= 0) {
      throw new Error(`Invalid framebuffer dimensions: ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.strideBytes = width * BYTES_PER_PIXEL;
    this.sizeBytes = width * height * BYTES_PER_PIXEL;
    this.buffer = new Uint8ClampedArray(this.sizeBytes);
  }

  getPixelBuffer(): Uint8ClampedArray {
    return this.buffer;
  }

  private checkCoordinates(x: number, y: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      throw new Error(
        `Framebuffer pixel coordinates out of bounds: (${x}, ${y}), dimensions: ${this.width}x${this.height}`
      );
    }
  }

  readPixel(x: number, y: number): number {
    this.checkCoordinates(x, y);
    const index = (y * this.width + x) * BYTES_PER_PIXEL;
    const r = this.buffer[index];
    const g = this.buffer[index + 1];
    const b = this.buffer[index + 2];
    const a = this.buffer[index + 3];
    return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  }

  writePixel(x: number, y: number, r: number, g: number, b: number, a: number): void {
    this.checkCoordinates(x, y);
    const index = (y * this.width + x) * BYTES_PER_PIXEL;
    this.buffer[index] = r;
    this.buffer[index + 1] = g;
    this.buffer[index + 2] = b;
    this.buffer[index + 3] = a;
    this.dirty = true;
  }

  readBytes(offset: number, length: number): Uint8Array {
    if (offset < 0 || offset + length > this.sizeBytes) {
      throw new Error(
        `Framebuffer read out of bounds: offset ${offset}, length ${length}, size ${this.sizeBytes}`
      );
    }
    return new Uint8Array(this.buffer.buffer, this.buffer.byteOffset + offset, length);
  }

  writeBytes(offset: number, data: Uint8Array): void {
    if (offset < 0 || offset + data.length > this.sizeBytes) {
      throw new Error(
        `Framebuffer write out of bounds: offset ${offset}, length ${data.length}, size ${this.sizeBytes}`
      );
    }
    this.buffer.set(data, offset);
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  clear(r = 0, g = 0, b = 0, a = 0): void {
    for (let i = 0; i < this.sizeBytes; i += BYTES_PER_PIXEL) {
      this.buffer[i] = r;
      this.buffer[i + 1] = g;
      this.buffer[i + 2] = b;
      this.buffer[i + 3] = a;
    }
    this.dirty = true;
  }
}
