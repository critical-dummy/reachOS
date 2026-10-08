import {FabricDessertBoardConfig} from './types';
import {Frt64CpuBoundary, IFrt64BusMaster, IFrt64CpuBoundary} from '../arch/frt64/boundary';
import {IPhysicalAddressSpace, PhysicalAddressSpace} from '../memory/address-space';
import {SparsePhysicalMemoryRegion} from '../memory/physical-memory';
import {MemoryRegionType} from '../memory/types';
import {DeviceBus, IDeviceBus} from '../device/bus';
import {FabricDessertDisplayDevice} from '../display/display-device';
import {IFabricDessertDisplayDevice} from '../display/types';
import {Address64} from '../types';

export interface IFabricDessertBoard {
  readonly config: FabricDessertBoardConfig;
  readonly addressSpace: IPhysicalAddressSpace;
  readonly cpuBoundary: IFrt64CpuBoundary;
  readonly deviceBus: IDeviceBus;
  readonly displayDevice: IFabricDessertDisplayDevice;

  reset(): void;
  powerOff(): void;
}

export class FabricDessertBoard implements IFabricDessertBoard {
  readonly config: FabricDessertBoardConfig;
  readonly addressSpace: IPhysicalAddressSpace;
  readonly cpuBoundary: IFrt64CpuBoundary;
  readonly deviceBus: IDeviceBus;
  readonly displayDevice: IFabricDessertDisplayDevice;

  constructor(config: FabricDessertBoardConfig) {
    this.config = config;

    // 1. Initialize Address Space
    this.addressSpace = new PhysicalAddressSpace();

    // 2. Map Configured RAM
    const ramRegion = new SparsePhysicalMemoryRegion(
      'sysram',
      'System RAM',
      config.memoryLayout.ramBase,
      config.memoryLayout.ramSizeBytes,
      MemoryRegionType.RAM,
      {read: true, write: true, execute: true}
    );
    this.addressSpace.mapRegion(ramRegion);

    // Optional ROM
    if (config.memoryLayout.romBase !== undefined && config.memoryLayout.romSizeBytes) {
      const romRegion = new SparsePhysicalMemoryRegion(
        'sysrom',
        'System ROM',
        config.memoryLayout.romBase,
        config.memoryLayout.romSizeBytes,
        MemoryRegionType.ROM,
        {read: true, write: false, execute: true}
      );
      this.addressSpace.mapRegion(romRegion);
    }

    // 3. Initialize Device Bus with configured MMIO window
    this.deviceBus = new DeviceBus(
      {
        mmioWindowBase: config.memoryLayout.mmioBase,
        mmioWindowSize: config.memoryLayout.mmioSizeBytes,
      },
      this.addressSpace
    );

    // 4. Register Platform Display Device
    this.displayDevice = new FabricDessertDisplayDevice();
    this.deviceBus.registerDevice(this.displayDevice);

    // 5. Initialize FRT64 CPU Boundary
    this.cpuBoundary = new Frt64CpuBoundary(config.cpuTopology);

    // 6. Connect CPU Boundary as bus master to physical address space
    const busMaster: IFrt64BusMaster = {
      readPhysical: (addr: Address64, size: number) => {
        return this.addressSpace.readBytes(addr, size);
      },
      writePhysical: (addr: Address64, data: Uint8Array) => {
        this.addressSpace.writeBytes(addr, data);
      },
    };
    this.cpuBoundary.attachBusMaster(busMaster);

    // 7. Connect DeviceBus interrupt routing to CPU boundary
    this.deviceBus.addInterruptListener((vector: number, level: boolean) => {
      if (level) {
        this.cpuBoundary.signalGlobalInterrupt(vector);
      }
    });
  }

  reset(): void {
    this.deviceBus.resetAllDevices();
    this.cpuBoundary.resetAll();
  }

  powerOff(): void {
    this.cpuBoundary.haltAll();
    this.deviceBus.terminateAllDevices();
  }
}
