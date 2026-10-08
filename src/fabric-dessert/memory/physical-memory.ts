import {Address64, Size64} from '../types';
import {IMemoryRegionDescriptor, MemoryPermissions, MemoryRegionType} from './types';

const PAGE_SIZE_BYTES = 65536; // 64 KiB sparse allocation granule
const PAGE_SIZE_BIG = BigInt(PAGE_SIZE_BYTES);

export interface IPhysicalMemoryRegion extends IMemoryRegionDescriptor {
  read8(offset: Size64): number;
  read16(offset: Size64): number;
  read32(offset: Size64): number;
  read64(offset: Size64): bigint;
  write8(offset: Size64, value: number): void;
  write16(offset: Size64, value: number): void;
  write32(offset: Size64, value: number): void;
  write64(offset: Size64, value: bigint): void;
  readBytes(offset: Size64, count: number): Uint8Array;
  writeBytes(offset: Size64, src: Uint8Array): void;
  clear(): void;
}

export class SparsePhysicalMemoryRegion implements IPhysicalMemoryRegion {
  readonly id: string;
  readonly name: string;
  readonly baseAddress: Address64;
  readonly size: Size64;
  readonly type: MemoryRegionType;
  readonly permissions: MemoryPermissions;

  // Sparse storage: maps page index to 64KB Uint8Array
  private readonly pages = new Map<number, Uint8Array>();

  constructor(
    id: string,
    name: string,
    baseAddress: Address64,
    size: Size64,
    type: MemoryRegionType,
    permissions: MemoryPermissions
  ) {
    if (size <= 0n) {
      throw new Error(`Memory region size must be > 0, received ${size}`);
    }
    this.id = id;
    this.name = name;
    this.baseAddress = baseAddress;
    this.size = size;
    this.type = type;
    this.permissions = permissions;
  }

  private checkBounds(offset: Size64, count: number): void {
    if (offset < 0n || offset + BigInt(count) > this.size) {
      throw new Error(
        `Memory access out of bounds for region ${this.name}: offset 0x${offset.toString(16)}, size ${count}, region size 0x${this.size.toString(16)}`
      );
    }
  }

  private checkPermission(mode: 'read' | 'write'): void {
    if (mode === 'read' && !this.permissions.read) {
      throw new Error(`Read permission denied on region ${this.name}`);
    }
    if (mode === 'write' && !this.permissions.write) {
      throw new Error(`Write permission denied on region ${this.name}`);
    }
  }

  private getOrCreatePage(pageIndex: number): Uint8Array {
    let page = this.pages.get(pageIndex);
    if (!page) {
      page = new Uint8Array(PAGE_SIZE_BYTES);
      this.pages.set(pageIndex, page);
    }
    return page;
  }

  read8(offset: Size64): number {
    this.checkBounds(offset, 1);
    this.checkPermission('read');
    const pageIdx = Number(offset / PAGE_SIZE_BIG);
    const pageOffset = Number(offset % PAGE_SIZE_BIG);
    const page = this.pages.get(pageIdx);
    return page ? page[pageOffset] : 0;
  }

  read16(offset: Size64): number {
    this.checkBounds(offset, 2);
    this.checkPermission('read');
    const b0 = this.read8(offset);
    const b1 = this.read8(offset + 1n);
    return b0 | (b1 << 8);
  }

  read32(offset: Size64): number {
    this.checkBounds(offset, 4);
    this.checkPermission('read');
    const b0 = this.read8(offset);
    const b1 = this.read8(offset + 1n);
    const b2 = this.read8(offset + 2n);
    const b3 = this.read8(offset + 3n);
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  read64(offset: Size64): bigint {
    this.checkBounds(offset, 8);
    this.checkPermission('read');
    const low = BigInt(this.read32(offset));
    const high = BigInt(this.read32(offset + 4n));
    return low | (high << 32n);
  }

  write8(offset: Size64, value: number): void {
    this.checkBounds(offset, 1);
    this.checkPermission('write');
    const pageIdx = Number(offset / PAGE_SIZE_BIG);
    const pageOffset = Number(offset % PAGE_SIZE_BIG);
    const page = this.getOrCreatePage(pageIdx);
    page[pageOffset] = value & 0xff;
  }

  write16(offset: Size64, value: number): void {
    this.checkBounds(offset, 2);
    this.checkPermission('write');
    this.write8(offset, value & 0xff);
    this.write8(offset + 1n, (value >> 8) & 0xff);
  }

  write32(offset: Size64, value: number): void {
    this.checkBounds(offset, 4);
    this.checkPermission('write');
    this.write8(offset, value & 0xff);
    this.write8(offset + 1n, (value >> 8) & 0xff);
    this.write8(offset + 2n, (value >> 16) & 0xff);
    this.write8(offset + 3n, (value >>> 24) & 0xff);
  }

  write64(offset: Size64, value: bigint): void {
    this.checkBounds(offset, 8);
    this.checkPermission('write');
    const low = Number(value & 0xffffffffn);
    const high = Number((value >> 32n) & 0xffffffffn);
    this.write32(offset, low);
    this.write32(offset + 4n, high);
  }

  readBytes(offset: Size64, count: number): Uint8Array {
    this.checkBounds(offset, count);
    this.checkPermission('read');
    const result = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.read8(offset + BigInt(i));
    }
    return result;
  }

  writeBytes(offset: Size64, src: Uint8Array): void {
    this.checkBounds(offset, src.length);
    this.checkPermission('write');
    for (let i = 0; i < src.length; i++) {
      this.write8(offset + BigInt(i), src[i]);
    }
  }

  clear(): void {
    this.pages.clear();
  }
}
