/**
 * Initiator-aware physical access context contract for Fabric Dessert.
 * Identifies the origin of memory and MMIO transactions across host, CPU, and device boundaries.
 */

export enum AccessInitiatorType {
  HOST = 'HOST',
  CPU = 'CPU',
  DEVICE = 'DEVICE',
}

export interface HostAccessContext {
  readonly initiatorType: AccessInitiatorType.HOST;
  readonly description?: string;
}

export interface CpuAccessContext {
  readonly initiatorType: AccessInitiatorType.CPU;
  readonly coreId: number;
  readonly clusterId?: number;
}

export interface DeviceAccessContext {
  readonly initiatorType: AccessInitiatorType.DEVICE;
  readonly deviceId: string;
}

export type PhysicalAccessContext =
  | HostAccessContext
  | CpuAccessContext
  | DeviceAccessContext;

export const DEFAULT_HOST_ACCESS_CONTEXT: HostAccessContext = Object.freeze({
  initiatorType: AccessInitiatorType.HOST,
});

export function createHostAccessContext(description?: string): HostAccessContext {
  return {
    initiatorType: AccessInitiatorType.HOST,
    ...(description !== undefined ? {description} : {}),
  };
}

export function createCpuAccessContext(coreId: number, clusterId?: number): CpuAccessContext {
  return {
    initiatorType: AccessInitiatorType.CPU,
    coreId,
    ...(clusterId !== undefined ? {clusterId} : {}),
  };
}

export function createDeviceAccessContext(deviceId: string): DeviceAccessContext {
  return {
    initiatorType: AccessInitiatorType.DEVICE,
    deviceId,
  };
}
