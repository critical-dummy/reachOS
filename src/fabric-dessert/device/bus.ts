import {
  Address64,
  assertValidAddress64,
  assertValidRegionRange,
  formatAddress,
  MAX_ADDRESS_64,
  Size64,
} from '../types';
import {IPhysicalAddressSpace} from '../memory/address-space';
import {DeviceRegistrationRecord, IDevice, IDeviceContext} from './types';

export interface IDeviceBusConfig {
  readonly mmioWindowBase: Address64;
  readonly mmioWindowSize: Size64;
}

export type InterruptListener = (vector: number, level: boolean) => void;

export interface IDeviceBus {
  readonly mmioWindowBase: Address64;
  readonly mmioWindowSize: Size64;
  registerDevice(device: IDevice): DeviceRegistrationRecord;
  unregisterDevice(deviceId: string): boolean;
  getDevice(deviceId: string): IDevice | undefined;
  listDevices(): readonly DeviceRegistrationRecord[];
  resetAllDevices(): void;
  terminateAllDevices(): void;
  addInterruptListener(listener: InterruptListener): () => void;
  dispatchInterrupt(vector: number, level: boolean): void;
}

export class DeviceBus implements IDeviceBus {
  readonly mmioWindowBase: Address64;
  readonly mmioWindowSize: Size64;
  private readonly addressSpace: IPhysicalAddressSpace;
  private nextFreeMmioAddress: Address64;
  private readonly devices = new Map<string, DeviceRegistrationRecord>();
  private readonly interruptListeners = new Set<InterruptListener>();
  private nextIrqVector = 16; // Standard user IRQs starting at vector 16

  constructor(config: IDeviceBusConfig, addressSpace: IPhysicalAddressSpace) {
    assertValidRegionRange(config.mmioWindowBase, config.mmioWindowSize, 'DeviceBus MMIO window');
    this.mmioWindowBase = config.mmioWindowBase;
    this.mmioWindowSize = config.mmioWindowSize;
    this.nextFreeMmioAddress = config.mmioWindowBase;
    this.addressSpace = addressSpace;
  }

  private alignUp(addr: Address64, alignment: Size64): Address64 {
    const remainder = addr % alignment;
    if (remainder === 0n) return addr;
    return addr + (alignment - remainder);
  }

  registerDevice(device: IDevice): DeviceRegistrationRecord {
    if (this.devices.has(device.id)) {
      throw new Error(`Device "${device.id}" is already registered on DeviceBus.`);
    }

    const mmioAllocations = new Map<string, Address64>();
    const assignedIrqs: number[] = [];

    // Assign IRQ vectors
    for (let i = 0; i < device.irqCount; i++) {
      assignedIrqs.push(this.nextIrqVector++);
    }

    // Allocate MMIO apertures
    for (const req of device.mmioRequests) {
      const alignment = req.alignment ?? 4096n; // default 4KB page align
      const alignedBase = this.alignUp(this.nextFreeMmioAddress, alignment);
      const apertureEnd = alignedBase + req.size;

      assertValidAddress64(alignedBase, `Device "${device.id}" aperture "${req.name}" base`);
      if (req.size <= 0n) {
        throw new Error(`Device "${device.id}" aperture "${req.name}" size must be > 0`);
      }
      if (alignedBase + req.size - 1n > MAX_ADDRESS_64) {
        throw new Error(
          `Device "${device.id}" aperture "${req.name}" exceeds 64-bit physical address space limit`
        );
      }

      if (apertureEnd > this.mmioWindowBase + this.mmioWindowSize) {
        throw new Error(
          `DeviceBus MMIO space exhausted when allocating "${req.name}" for device "${device.id}". Required ${req.size} bytes at ${formatAddress(alignedBase)}.`
        );
      }

      this.addressSpace.mapMMIO({
        id: `${device.id}:${req.name}`,
        name: `${device.name} [${req.name}]`,
        baseAddress: alignedBase,
        size: req.size,
        handler: req.handler,
      });

      mmioAllocations.set(req.name, alignedBase);
      this.nextFreeMmioAddress = apertureEnd;
    }

    const context: IDeviceContext = {
      deviceId: device.id,
      getMmioBase: (name: string) => {
        const base = mmioAllocations.get(name);
        if (base === undefined) {
          throw new Error(`Unknown MMIO aperture "${name}" for device "${device.id}"`);
        }
        return base;
      },
      readPhysical: (address: Address64, count: number) => {
        return this.addressSpace.readBytes(address, count);
      },
      writePhysical: (address: Address64, data: Uint8Array) => {
        this.addressSpace.writeBytes(address, data);
      },
      raiseInterrupt: (vector: number) => {
        this.dispatchInterrupt(vector, true);
      },
      lowerInterrupt: (vector: number) => {
        this.dispatchInterrupt(vector, false);
      },
    };

    device.initialize(context);

    const record: DeviceRegistrationRecord = {
      device,
      mmioAllocations,
      assignedIrqs,
      registeredAt: Date.now(),
    };

    this.devices.set(device.id, record);
    return record;
  }

  unregisterDevice(deviceId: string): boolean {
    const record = this.devices.get(deviceId);
    if (!record) return false;

    // Unmap MMIOs
    for (const req of record.device.mmioRequests) {
      this.addressSpace.unmapMMIO(`${deviceId}:${req.name}`);
    }

    record.device.terminate();
    this.devices.delete(deviceId);
    return true;
  }

  getDevice(deviceId: string): IDevice | undefined {
    return this.devices.get(deviceId)?.device;
  }

  listDevices(): readonly DeviceRegistrationRecord[] {
    return Array.from(this.devices.values());
  }

  resetAllDevices(): void {
    for (const record of this.devices.values()) {
      record.device.reset();
    }
  }

  terminateAllDevices(): void {
    for (const record of this.devices.values()) {
      record.device.terminate();
    }
    this.devices.clear();
  }

  addInterruptListener(listener: InterruptListener): () => void {
    this.interruptListeners.add(listener);
    return () => {
      this.interruptListeners.delete(listener);
    };
  }

  dispatchInterrupt(vector: number, level: boolean): void {
    for (const listener of this.interruptListeners) {
      listener(vector, level);
    }
  }
}
