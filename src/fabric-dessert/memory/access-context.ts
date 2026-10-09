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
  if (description !== undefined && (typeof description !== 'string' || description.trim().length === 0)) {
    throw new Error(`Invalid host access context description: "${description}"`);
  }
  return Object.freeze({
    initiatorType: AccessInitiatorType.HOST,
    ...(description !== undefined ? {description} : {}),
  });
}

export function createCpuAccessContext(coreId: number, clusterId?: number): CpuAccessContext {
  if (typeof coreId !== 'number' || !Number.isSafeInteger(coreId) || coreId < 0) {
    throw new Error(`Invalid CPU coreId: ${coreId}`);
  }
  if (clusterId !== undefined && (typeof clusterId !== 'number' || !Number.isSafeInteger(clusterId) || clusterId < 0)) {
    throw new Error(`Invalid CPU clusterId: ${clusterId}`);
  }
  return Object.freeze({
    initiatorType: AccessInitiatorType.CPU,
    coreId,
    ...(clusterId !== undefined ? {clusterId} : {}),
  });
}

export function createDeviceAccessContext(deviceId: string): DeviceAccessContext {
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
    throw new Error(`Invalid deviceId: "${deviceId}"`);
  }
  return Object.freeze({
    initiatorType: AccessInitiatorType.DEVICE,
    deviceId,
  });
}
