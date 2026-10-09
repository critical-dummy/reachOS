import {Address64, Size64} from '../types';
import {DeviceAccessContext} from '../memory/access-context';
import {IMMIOHandler} from '../memory/address-space';

export enum DeviceClass {
  SYSTEM_CONTROLLER = 'SYSTEM_CONTROLLER',
  INTERRUPT_CONTROLLER = 'INTERRUPT_CONTROLLER',
  TIMER = 'TIMER',
  DISPLAY_CONTROLLER = 'DISPLAY_CONTROLLER',
  BLOCK_STORAGE = 'BLOCK_STORAGE',
  SERIAL_PORT = 'SERIAL_PORT',
  BUS_CONTROLLER = 'BUS_CONTROLLER',
  GENERIC = 'GENERIC',
}

export interface MmioApertureRequest {
  readonly name: string;
  readonly size: Size64;
  readonly alignment?: Size64;
  readonly handler: IMMIOHandler;
}

export interface IDeviceContext {
  readonly deviceId: string;
  readonly accessContext: DeviceAccessContext;
  getMmioBase(apertureName: string): Address64;
  readPhysical(address: Address64, sizeBytes: number): Uint8Array;
  writePhysical(address: Address64, data: Uint8Array): void;
  raiseInterrupt(vector: number): void;
  lowerInterrupt(vector: number): void;
}

export interface IDevice {
  readonly id: string;
  readonly name: string;
  readonly deviceClass: DeviceClass;
  readonly mmioRequests: readonly MmioApertureRequest[];
  readonly irqCount: number;

  initialize(context: IDeviceContext): void;
  reset(): void;
  terminate(): void;
}

export interface DeviceRegistrationRecord {
  readonly device: IDevice;
  readonly mmioAllocations: ReadonlyMap<string, Address64>;
  readonly assignedIrqs: readonly number[];
  readonly registeredAt: number;
}
