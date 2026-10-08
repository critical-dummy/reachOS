import {Address64, formatAddress, Size64} from '../types';
import {IPhysicalMemoryRegion} from '../memory/physical-memory';
import {MemoryPermissions, MemoryRegionType} from '../memory/types';

const PAGE_SIZE_BYTES = 65536; // 64 KiB sparse allocation chunk
const PAGE_SIZE_BIG = BigInt(PAGE_SIZE_BYTES);

export interface IBootRom extends IPhysicalMemoryRegion {
  readonly resetEntry: Address64;
}

/**
 * Fabric Dessert Boot ROM.
 * A genuinely immutable physical memory region mapped into the platform physical address space.
 * Backed by sparse allocation so large ROM configurations are not silently truncated.
 * Contents are established strictly during construction and protected against runtime modification.
 */
export class BootRom implements IBootRom {
  readonly id = 'bootrom';
  readonly name = 'Fabric Dessert Boot ROM';
  readonly baseAddress: Address64;
  readonly size: Size64;
  readonly type = MemoryRegionType.ROM;
  readonly permissions: MemoryPermissions = {
    read: true,
    write: false,
    execute: true,
  };
  readonly resetEntry: Address64;

  // Sparse 64 KiB page storage ensuring no silent size caps
  private readonly pages = new Map<number, Uint8Array>();

  constructor(
    baseAddress: Address64,
    size: Size64,
    resetEntry: Address64 = baseAddress,
    initialPayload?: Uint8Array
  ) {
    if (size <= 0n) {
      throw new Error(`Boot ROM size must be positive, received: ${size}`);
    }

    if (resetEntry < baseAddress || resetEntry >= baseAddress + size) {
      throw new Error(
        `Reset entry ${formatAddress(resetEntry)} outside Boot ROM boundary [${formatAddress(baseAddress)}, ${formatAddress(baseAddress + size)}]`
      );
    }

    this.baseAddress = baseAddress;
    this.size = size;
    this.resetEntry = resetEntry;

    if (initialPayload && initialPayload.length > 0) {
      this.provisionPayload(initialPayload);
    }
  }

  /**
   * Internal constructor-only provisioning mechanism.
   * Not exposed on IBootRom interface.
   */
  private provisionPayload(payload: Uint8Array): void {
    if (BigInt(payload.length) > this.size) {
      throw new Error(
        `Initial payload size (${payload.length} bytes) exceeds Boot ROM capacity (${this.size} bytes)`
      );
    }

    for (let i = 0; i < payload.length; i++) {
      const offsetBig = BigInt(i);
      const pageIdx = Number(offsetBig / PAGE_SIZE_BIG);
      const pageOffset = Number(offsetBig % PAGE_SIZE_BIG);

      let page = this.pages.get(pageIdx);
      if (!page) {
        page = new Uint8Array(PAGE_SIZE_BYTES);
        this.pages.set(pageIdx, page);
      }
      page[pageOffset] = payload[i];
    }
  }

  private checkBounds(offset: Size64, count: number): void {
    if (offset < 0n || offset + BigInt(count) > this.size) {
      throw new Error(
        `Boot ROM access out of bounds: offset 0x${offset.toString(16)}, count ${count}, size 0x${this.size.toString(16)}`
      );
    }
  }

  read8(offset: Size64): number {
    this.checkBounds(offset, 1);
    const pageIdx = Number(offset / PAGE_SIZE_BIG);
    const pageOffset = Number(offset % PAGE_SIZE_BIG);
    const page = this.pages.get(pageIdx);
    return page ? page[pageOffset] : 0;
  }

  read16(offset: Size64): number {
    this.checkBounds(offset, 2);
    const b0 = this.read8(offset);
    const b1 = this.read8(offset + 1n);
    return b0 | (b1 << 8);
  }

  read32(offset: Size64): number {
    this.checkBounds(offset, 4);
    const b0 = this.read8(offset);
    const b1 = this.read8(offset + 1n);
    const b2 = this.read8(offset + 2n);
    const b3 = this.read8(offset + 3n);
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  read64(offset: Size64): bigint {
    this.checkBounds(offset, 8);
    const low = BigInt(this.read32(offset));
    const high = BigInt(this.read32(offset + 4n));
    return low | (high << 32n);
  }

  write8(_offset: Size64, _value: number): void {
    void _offset;
    void _value;
    throw new Error('Write permission denied on Boot ROM: memory region is read-only');
  }

  write16(_offset: Size64, _value: number): void {
    void _offset;
    void _value;
    throw new Error('Write permission denied on Boot ROM: memory region is read-only');
  }

  write32(_offset: Size64, _value: number): void {
    void _offset;
    void _value;
    throw new Error('Write permission denied on Boot ROM: memory region is read-only');
  }

  write64(_offset: Size64, _value: bigint): void {
    void _offset;
    void _value;
    throw new Error('Write permission denied on Boot ROM: memory region is read-only');
  }

  readBytes(offset: Size64, count: number): Uint8Array {
    this.checkBounds(offset, count);
    const result = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.read8(offset + BigInt(i));
    }
    return result;
  }

  writeBytes(_offset: Size64, _src: Uint8Array): void {
    void _offset;
    void _src;
    throw new Error('Write permission denied on Boot ROM: memory region is read-only');
  }

  clear(): void {
    throw new Error('Clear operation not supported on immutable Boot ROM');
  }
}
