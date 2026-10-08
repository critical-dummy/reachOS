import {Address64, formatAddress, Size64} from '../types';
import {IPhysicalMemoryRegion} from '../memory/physical-memory';
import {MemoryPermissions, MemoryRegionType} from '../memory/types';

export interface IBootRom extends IPhysicalMemoryRegion {
  readonly resetEntry: Address64;
  loadPayload(offset: Size64, data: Uint8Array): void;
}

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

  private readonly storage: Uint8Array;

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

    // Allocate physical ROM storage (capped safely at 64MB if huge)
    const allocSize = Number(size > 67108864n ? 67108864n : size);
    this.storage = new Uint8Array(allocSize);

    if (initialPayload) {
      this.loadPayload(0n, initialPayload);
    }
  }

  loadPayload(offset: Size64, data: Uint8Array): void {
    const off = Number(offset);
    if (off < 0 || off + data.length > this.storage.length) {
      throw new Error(
        `Payload size ${data.length} at offset ${off} exceeds Boot ROM capacity ${this.storage.length}`
      );
    }
    this.storage.set(data, off);
  }

  private checkBounds(offset: Size64, count: number): void {
    if (offset < 0n || offset + BigInt(count) > this.size) {
      throw new Error(
        `Boot ROM access out of bounds: offset ${offset}, count ${count}, size ${this.size}`
      );
    }
  }

  read8(offset: Size64): number {
    this.checkBounds(offset, 1);
    const off = Number(offset);
    return off < this.storage.length ? this.storage[off] : 0;
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
    const off = Number(offset);
    if (off + count <= this.storage.length) {
      return this.storage.slice(off, off + count);
    }
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
    // ROM clear is not allowed at runtime
    throw new Error('Clear operation not supported on read-only Boot ROM');
  }
}
