import {Address64, Size64} from '../types';

export * from './access-context';

export enum MemoryRegionType {
  RAM = 'RAM',
  ROM = 'ROM',
  MMIO = 'MMIO',
  RESERVED = 'RESERVED',
}

export interface MemoryPermissions {
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface IMemoryRegionDescriptor {
  readonly id: string;
  readonly name: string;
  readonly baseAddress: Address64;
  readonly size: Size64;
  readonly type: MemoryRegionType;
  readonly permissions: MemoryPermissions;
}

export interface MemoryAccessFault {
  faultAddress: Address64;
  operation: 'read' | 'write';
  reason: 'UNMAPPED' | 'PERMISSION_DENIED' | 'UNALIGNED' | 'DEVICE_ERROR';
}
