import {FabricDessertBoardConfig, FabricDessertBootContract} from './types';
import {BootRom, IBootRom} from './boot-rom';
import {Frt64CpuBoundary, IFrt64BusMaster, IFrt64CpuBoundary} from '../arch/frt64/boundary';
import {IPhysicalAddressSpace, PhysicalAddressSpace} from '../memory/address-space';
import {PhysicalAccessContext} from '../memory/access-context';
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
  readonly bootRom: IBootRom;
  readonly bootContract: FabricDessertBootContract;

  start(): void;
  pause(): void;
  resume(): void;
  reset(): void;
  powerOff(): void;
}

export class FabricDessertBoard implements IFabricDessertBoard {
  readonly config: FabricDessertBoardConfig;
  readonly addressSpace: IPhysicalAddressSpace;
  readonly cpuBoundary: IFrt64CpuBoundary;
  readonly deviceBus: IDeviceBus;
  readonly displayDevice: IFabricDessertDisplayDevice;
  readonly bootRom: IBootRom;

  constructor(config: FabricDessertBoardConfig) {
    this.config = config;

    // 1. Initialize Address Space
    this.addressSpace = new PhysicalAddressSpace();

    // 2. Map Boot ROM into Physical Address Space
    this.bootRom = new BootRom(
      config.bootContract.bootRomBase,
      config.bootContract.bootRomSizeBytes,
      config.bootContract.resetVector,
      config.bootContract.initialPayload
    );
    this.addressSpace.mapRegion(this.bootRom);

    // 3. Map Configured RAM
    const ramRegion = new SparsePhysicalMemoryRegion(
      'sysram',
      'System RAM',
      config.memoryLayout.ramBase,
      config.memoryLayout.ramSizeBytes,
      MemoryRegionType.RAM,
      {read: true, write: true, execute: true}
    );
    this.addressSpace.mapRegion(ramRegion);

    // Optional Additional ROM
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

    // 4. Initialize Device Bus with configured MMIO window
    this.deviceBus = new DeviceBus(
      {
        mmioWindowBase: config.memoryLayout.mmioBase,
        mmioWindowSize: config.memoryLayout.mmioSizeBytes,
      },
      this.addressSpace
    );

    // 5. Register Platform Display Device
    this.displayDevice = new FabricDessertDisplayDevice();
    this.deviceBus.registerDevice(this.displayDevice);

    // 6. Initialize FRT64 CPU Boundary with configured reset vector
    this.cpuBoundary = new Frt64CpuBoundary({
      ...config.cpuTopology,
      defaultResetVector: config.bootContract.resetVector,
    });

    // 7. Connect CPU Boundary as bus master to physical address space
    const busMaster: IFrt64BusMaster = {
      readPhysical: (addr: Address64, size: number, context?: PhysicalAccessContext) => {
        return this.addressSpace.readBytes(addr, size, context);
      },
      writePhysical: (addr: Address64, data: Uint8Array, context?: PhysicalAccessContext) => {
        this.addressSpace.writeBytes(addr, data, context);
      },
      fetchInstructionPhysical: (addr: Address64, size: number, context?: PhysicalAccessContext) => {
        return this.addressSpace.fetchInstructionBytes(addr, size, context);
      },
    };
    this.cpuBoundary.attachBusMaster(busMaster);

    // 8. Connect DeviceBus interrupt routing to CPU boundary
    this.deviceBus.addInterruptListener((vector: number, level: boolean) => {
      if (level) {
        this.cpuBoundary.signalGlobalInterrupt(vector);
      }
    });
  }

  get bootContract(): FabricDessertBootContract {
    return this.config.bootContract;
  }

  start(): void {
    // Only the primary boot CPU enters the running boot path.
    // Secondary CPUs remain parked/held in reset.
    this.cpuBoundary.resumePrimary();
  }

  pause(): void {
    // Preserves PARKED secondary CPUs by only pausing running cores
    this.cpuBoundary.pauseRunningCores();
  }

  resume(): void {
    // Preserves PARKED secondary CPUs by only resuming paused cores
    this.cpuBoundary.resumePausedCores();
  }

  reset(): void {
    this.deviceBus.resetAllDevices();
    // Reset CPU cores: primary core enters RESET at bootContract.resetVector; secondary cores are parked
    this.cpuBoundary.resetAll(this.config.bootContract.resetVector);
  }

  powerOff(): void {
    this.cpuBoundary.haltAll();
    this.deviceBus.terminateAllDevices();
  }
}
