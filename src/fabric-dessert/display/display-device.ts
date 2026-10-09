import {DeviceClass, IDevice, IDeviceContext, MmioApertureRequest} from '../device/types';
import {Size64} from '../types';
import {IMMIOHandler} from '../memory/address-space';
import {Framebuffer} from './framebuffer';
import {SystemRenderer} from './system-renderer';
import {
  BYTES_PER_PIXEL,
  DISPLAY_HEIGHT,
  DISPLAY_STRIDE_BYTES,
  DISPLAY_WIDTH,
  FRAMEBUFFER_SIZE_BYTES,
  IFabricDessertDisplayDevice,
  IFramebuffer,
  ISystemRenderer,
} from './types';

const MAGIC_FDIS = 0x53494446n; // "FDIS" in little-endian ASCII

export class FabricDessertDisplayDevice implements IFabricDessertDisplayDevice, IDevice {
  readonly id = 'fdis_display0';
  readonly name = 'Fabric Dessert Display Controller';
  readonly deviceClass = DeviceClass.DISPLAY_CONTROLLER;
  readonly irqCount = 1;

  readonly framebuffer: IFramebuffer;
  readonly systemRenderer: ISystemRenderer;

  private deviceContext: IDeviceContext | null = null;
  private enabled = true;

  readonly mmioRequests: readonly MmioApertureRequest[];

  constructor() {
    this.framebuffer = new Framebuffer(DISPLAY_WIDTH, DISPLAY_HEIGHT);
    this.systemRenderer = new SystemRenderer(this.framebuffer);

    // Control MMIO Aperture
    const ctrlHandler: IMMIOHandler = {
      read: (offset: Size64, _sizeBytes: number): bigint => {
        void _sizeBytes;
        const off = Number(offset);
        switch (off) {
          case 0x00:
            return MAGIC_FDIS;
          case 0x04:
            return BigInt(DISPLAY_WIDTH);
          case 0x08:
            return BigInt(DISPLAY_HEIGHT);
          case 0x0c:
            return BigInt(DISPLAY_STRIDE_BYTES);
          case 0x10:
            return BigInt(BYTES_PER_PIXEL);
          case 0x14: {
            let status = 0n;
            if (this.enabled) status |= 1n;
            if (this.framebuffer.isDirty()) status |= 2n;
            return status;
          }
          default:
            return 0n;
        }
      },
      write: (offset: Size64, value: bigint, _sizeBytes: number): void => {
        void _sizeBytes;
        const off = Number(offset);
        switch (off) {
          case 0x14:
            this.enabled = (value & 1n) !== 0n;
            break;
          case 0x18: {
            // Command register
            const cmd = Number(value & 0xffn);
            if (cmd === 1) {
              // Commit / Flush
              this.flush();
            } else if (cmd === 2) {
              // Clear screen
              this.framebuffer.clear(0, 0, 0, 255);
              this.flush();
            }
            break;
          }
          default:
            break;
        }
      },
    };

    // Framebuffer Direct Memory Aperture
    const fbHandler: IMMIOHandler = {
      read: (offset: Size64, sizeBytes: number): bigint => {
        const off = Number(offset);
        if (off < 0 || off + sizeBytes > FRAMEBUFFER_SIZE_BYTES) {
          return 0n;
        }
        const bytes = this.framebuffer.readBytes(off, sizeBytes);
        let result = 0n;
        for (let i = 0; i < sizeBytes; i++) {
          result |= BigInt(bytes[i]) << BigInt(i * 8);
        }
        return result;
      },
      write: (offset: Size64, value: bigint, sizeBytes: number): void => {
        const off = Number(offset);
        if (off < 0 || off + sizeBytes > FRAMEBUFFER_SIZE_BYTES) {
          return;
        }
        const bytes = new Uint8Array(sizeBytes);
        for (let i = 0; i < sizeBytes; i++) {
          bytes[i] = Number((value >> BigInt(i * 8)) & 0xffn);
        }
        this.framebuffer.writeBytes(off, bytes);
      },
      readBytes: (offset: Size64, count: number): Uint8Array => {
        const off = Number(offset);
        if (off < 0 || off + count > FRAMEBUFFER_SIZE_BYTES) {
          return new Uint8Array(count);
        }
        return this.framebuffer.readBytes(off, count);
      },
      writeBytes: (offset: Size64, data: Uint8Array): void => {
        const off = Number(offset);
        if (off < 0 || off + data.length > FRAMEBUFFER_SIZE_BYTES) {
          return;
        }
        this.framebuffer.writeBytes(off, data);
      },
    };

    this.mmioRequests = [
      {
        name: 'ctrl',
        size: 64n,
        alignment: 4096n,
        handler: ctrlHandler,
      },
      {
        name: 'fb',
        size: BigInt(FRAMEBUFFER_SIZE_BYTES),
        alignment: 65536n, // 64KB aligned
        handler: fbHandler,
      },
    ];
  }

  initialize(context: IDeviceContext): void {
    this.deviceContext = context;
    // Clear display buffer initially (black, fully opaque)
    this.framebuffer.clear(0, 0, 0, 255);
    this.flush();
  }

  reset(): void {
    this.enabled = true;
    this.framebuffer.clear(0, 0, 0, 255);
    this.flush();
  }

  terminate(): void {
    this.systemRenderer.detachOutputBackend();
    this.deviceContext = null;
  }

  flush(): void {
    if (this.enabled) {
      this.systemRenderer.flush();
      if (this.deviceContext) {
        // Signal VSYNC / present IRQ (line 0)
        this.deviceContext.raiseInterrupt(0);
        this.deviceContext.lowerInterrupt(0);
      }
    }
  }
}
