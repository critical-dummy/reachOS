import {
  Address64,
  assertValidAddress64,
  assertValidRegionRange,
  formatAddress,
  MAX_ADDRESS_64,
  Size64,
} from '../types';
import {DEFAULT_HOST_ACCESS_CONTEXT, PhysicalAccessContext} from './access-context';
import {IPhysicalMemoryRegion} from './physical-memory';
import {IMemoryRegionDescriptor} from './types';

export interface IMMIOHandler {
  read(offset: Size64, sizeBytes: number, context?: PhysicalAccessContext): bigint;
  write(offset: Size64, value: bigint, sizeBytes: number, context?: PhysicalAccessContext): void;
}

export interface IMMIORangeDescriptor {
  readonly id: string;
  readonly name: string;
  readonly baseAddress: Address64;
  readonly size: Size64;
  readonly handler: IMMIOHandler;
}

export interface IPhysicalAddressSpace {
  mapRegion(region: IPhysicalMemoryRegion): void;
  unmapRegion(id: string): boolean;
  mapMMIO(descriptor: IMMIORangeDescriptor): void;
  unmapMMIO(id: string): boolean;
  getRegionAt(address: Address64): IPhysicalMemoryRegion | undefined;
  getMMIOAt(address: Address64): IMMIORangeDescriptor | undefined;
  listRegions(): readonly IMemoryRegionDescriptor[];
  listMMIORanges(): readonly IMMIORangeDescriptor[];

  read8(address: Address64, context?: PhysicalAccessContext): number;
  read16(address: Address64, context?: PhysicalAccessContext): number;
  read32(address: Address64, context?: PhysicalAccessContext): number;
  read64(address: Address64, context?: PhysicalAccessContext): bigint;

  write8(address: Address64, value: number, context?: PhysicalAccessContext): void;
  write16(address: Address64, value: number, context?: PhysicalAccessContext): void;
  write32(address: Address64, value: number, context?: PhysicalAccessContext): void;
  write64(address: Address64, value: bigint, context?: PhysicalAccessContext): void;

  readBytes(address: Address64, count: number, context?: PhysicalAccessContext): Uint8Array;
  writeBytes(address: Address64, data: Uint8Array, context?: PhysicalAccessContext): void;

  /**
   * Pre-MMU physical instruction fetch operation.
   * Resolves the physical region, verifies execute permission, and returns raw instruction bytes.
   * Faults if the address is unmapped, within MMIO, or within a non-executable region.
   */
  fetchInstructionBytes(address: Address64, count: number, context?: PhysicalAccessContext): Uint8Array;
}

export class PhysicalAddressSpace implements IPhysicalAddressSpace {
  private readonly regions: IPhysicalMemoryRegion[] = [];
  private readonly mmioRanges: IMMIORangeDescriptor[] = [];

  private assertNoOverlap(base: Address64, size: Size64, excludeId?: string): void {
    const end = base + size;
    for (const r of this.regions) {
      if (r.id === excludeId) continue;
      const rEnd = r.baseAddress + r.size;
      if (base < rEnd && end > r.baseAddress) {
        throw new Error(
          `Memory range conflict: [${formatAddress(base)}, ${formatAddress(end)}] overlaps with existing region "${r.name}" [${formatAddress(r.baseAddress)}, ${formatAddress(rEnd)}]`
        );
      }
    }
    for (const m of this.mmioRanges) {
      if (m.id === excludeId) continue;
      const mEnd = m.baseAddress + m.size;
      if (base < mEnd && end > m.baseAddress) {
        throw new Error(
          `Memory range conflict: [${formatAddress(base)}, ${formatAddress(end)}] overlaps with MMIO range "${m.name}" [${formatAddress(m.baseAddress)}, ${formatAddress(mEnd)}]`
        );
      }
    }
  }

  mapRegion(region: IPhysicalMemoryRegion): void {
    assertValidRegionRange(region.baseAddress, region.size, `Region "${region.name}"`);
    this.assertNoOverlap(region.baseAddress, region.size, region.id);
    this.regions.push(region);
  }

  unmapRegion(id: string): boolean {
    const idx = this.regions.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.regions.splice(idx, 1);
      return true;
    }
    return false;
  }

  mapMMIO(descriptor: IMMIORangeDescriptor): void {
    assertValidRegionRange(descriptor.baseAddress, descriptor.size, `MMIO range "${descriptor.name}"`);
    this.assertNoOverlap(descriptor.baseAddress, descriptor.size, descriptor.id);
    this.mmioRanges.push(descriptor);
  }

  unmapMMIO(id: string): boolean {
    const idx = this.mmioRanges.findIndex((m) => m.id === id);
    if (idx >= 0) {
      this.mmioRanges.splice(idx, 1);
      return true;
    }
    return false;
  }

  getRegionAt(address: Address64): IPhysicalMemoryRegion | undefined {
    assertValidAddress64(address, 'getRegionAt address');
    return this.regions.find(
      (r) => address >= r.baseAddress && address < r.baseAddress + r.size
    );
  }

  getMMIOAt(address: Address64): IMMIORangeDescriptor | undefined {
    assertValidAddress64(address, 'getMMIOAt address');
    return this.mmioRanges.find(
      (m) => address >= m.baseAddress && address < m.baseAddress + m.size
    );
  }

  listRegions(): readonly IMemoryRegionDescriptor[] {
    return [...this.regions];
  }

  listMMIORanges(): readonly IMMIORangeDescriptor[] {
    return [...this.mmioRanges];
  }

  private checkAccessRange(address: Address64, count: number): void {
    assertValidAddress64(address, 'Physical access address');
    if (count < 0) {
      throw new Error(`Invalid access byte count: ${count}`);
    }
    if (count > 0) {
      const lastByte = address + BigInt(count) - 1n;
      if (lastByte > MAX_ADDRESS_64) {
        throw new Error(
          `Physical access at ${formatAddress(address)} with size ${count} exceeds 64-bit physical address space limit`
        );
      }
    }
  }

  read8(address: Address64, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): number {
    this.checkAccessRange(address, 1);
    const region = this.getRegionAt(address);
    if (region) {
      return region.read8(address - region.baseAddress, context);
    }
    const mmio = this.getMMIOAt(address);
    if (mmio) {
      return Number(mmio.handler.read(address - mmio.baseAddress, 1, context) & 0xffn);
    }
    throw new Error(`Unmapped physical memory read8 at ${formatAddress(address)}`);
  }

  read16(address: Address64, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): number {
    this.checkAccessRange(address, 2);
    const region = this.getRegionAt(address);
    if (region) {
      return region.read16(address - region.baseAddress, context);
    }
    const mmio = this.getMMIOAt(address);
    if (mmio) {
      return Number(mmio.handler.read(address - mmio.baseAddress, 2, context) & 0xffffn);
    }
    throw new Error(`Unmapped physical memory read16 at ${formatAddress(address)}`);
  }

  read32(address: Address64, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): number {
    this.checkAccessRange(address, 4);
    const region = this.getRegionAt(address);
    if (region) {
      return region.read32(address - region.baseAddress, context);
    }
    const mmio = this.getMMIOAt(address);
    if (mmio) {
      return Number(mmio.handler.read(address - mmio.baseAddress, 4, context) & 0xffffffffn);
    }
    throw new Error(`Unmapped physical memory read32 at ${formatAddress(address)}`);
  }

  read64(address: Address64, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): bigint {
    this.checkAccessRange(address, 8);
    const region = this.getRegionAt(address);
    if (region) {
      return region.read64(address - region.baseAddress, context);
    }
    const mmio = this.getMMIOAt(address);
    if (mmio) {
      return mmio.handler.read(address - mmio.baseAddress, 8, context);
    }
    throw new Error(`Unmapped physical memory read64 at ${formatAddress(address)}`);
  }

  write8(address: Address64, value: number, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): void {
    this.checkAccessRange(address, 1);
    const region = this.getRegionAt(address);
    if (region) {
      region.write8(address - region.baseAddress, value, context);
      return;
    }
    const mmio = this.getMMIOAt(address);
    if (mmio) {
      mmio.handler.write(address - mmio.baseAddress, BigInt(value & 0xff), 1, context);
      return;
    }
    throw new Error(`Unmapped physical memory write8 at ${formatAddress(address)}`);
  }

  write16(address: Address64, value: number, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): void {
    this.checkAccessRange(address, 2);
    const region = this.getRegionAt(address);
    if (region) {
      region.write16(address - region.baseAddress, value, context);
      return;
    }
    const mmio = this.getMMIOAt(address);
    if (mmio) {
      mmio.handler.write(address - mmio.baseAddress, BigInt(value & 0xffff), 2, context);
      return;
    }
    throw new Error(`Unmapped physical memory write16 at ${formatAddress(address)}`);
  }

  write32(address: Address64, value: number, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): void {
    this.checkAccessRange(address, 4);
    const region = this.getRegionAt(address);
    if (region) {
      region.write32(address - region.baseAddress, value, context);
      return;
    }
    const mmio = this.getMMIOAt(address);
    if (mmio) {
      mmio.handler.write(address - mmio.baseAddress, BigInt(value >>> 0), 4, context);
      return;
    }
    throw new Error(`Unmapped physical memory write32 at ${formatAddress(address)}`);
  }

  write64(address: Address64, value: bigint, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): void {
    this.checkAccessRange(address, 8);
    const region = this.getRegionAt(address);
    if (region) {
      region.write64(address - region.baseAddress, value, context);
      return;
    }
    const mmio = this.getMMIOAt(address);
    if (mmio) {
      mmio.handler.write(address - mmio.baseAddress, value, 8, context);
      return;
    }
    throw new Error(`Unmapped physical memory write64 at ${formatAddress(address)}`);
  }

  readBytes(address: Address64, count: number, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): Uint8Array {
    this.checkAccessRange(address, count);
    const region = this.getRegionAt(address);
    if (region && address + BigInt(count) <= region.baseAddress + region.size) {
      return region.readBytes(address - region.baseAddress, count, context);
    }
    const mmio = this.getMMIOAt(address);
    if (mmio && address + BigInt(count) <= mmio.baseAddress + mmio.size && count >= 1 && count <= 8) {
      const val = mmio.handler.read(address - mmio.baseAddress, count, context);
      const result = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        result[i] = Number((val >> BigInt(i * 8)) & 0xffn);
      }
      return result;
    }
    const result = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.read8(address + BigInt(i), context);
    }
    return result;
  }

  writeBytes(address: Address64, data: Uint8Array, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): void {
    this.checkAccessRange(address, data.length);
    const region = this.getRegionAt(address);
    if (region && address + BigInt(data.length) <= region.baseAddress + region.size) {
      region.writeBytes(address - region.baseAddress, data, context);
      return;
    }
    const mmio = this.getMMIOAt(address);
    if (mmio && address + BigInt(data.length) <= mmio.baseAddress + mmio.size && data.length >= 1 && data.length <= 8) {
      let val = 0n;
      for (let i = 0; i < data.length; i++) {
        val |= BigInt(data[i]) << BigInt(i * 8);
      }
      mmio.handler.write(address - mmio.baseAddress, val, data.length, context);
      return;
    }
    for (let i = 0; i < data.length; i++) {
      this.write8(address + BigInt(i), data[i], context);
    }
  }

  fetchInstructionBytes(address: Address64, count: number, context: PhysicalAccessContext = DEFAULT_HOST_ACCESS_CONTEXT): Uint8Array {
    this.checkAccessRange(address, count);

    const region = this.getRegionAt(address);
    if (!region) {
      const mmio = this.getMMIOAt(address);
      if (mmio) {
        throw new Error(
          `Instruction fetch fault at ${formatAddress(address)}: MMIO range "${mmio.name}" is not executable`
        );
      }
      throw new Error(
        `Instruction fetch fault at ${formatAddress(address)}: unmapped physical memory region`
      );
    }

    if (!region.permissions.execute) {
      throw new Error(
        `Instruction fetch fault at ${formatAddress(address)}: region "${region.name}" does not have execute permission`
      );
    }

    if (address + BigInt(count) > region.baseAddress + region.size) {
      throw new Error(
        `Instruction fetch fault at ${formatAddress(address)}: instruction fetch crosses region boundary`
      );
    }

    return region.readBytes(address - region.baseAddress, count, context);
  }
}
