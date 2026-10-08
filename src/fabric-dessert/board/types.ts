import {Address64, Size64} from '../types';
import {Frt64ExecutionFamily, Frt64TopologyConfig} from '../arch/frt64/types';

export interface MemoryLayoutConfig {
  ramBase: Address64;
  ramSizeBytes: Size64;
  romBase?: Address64;
  romSizeBytes?: Size64;
  mmioBase: Address64;
  mmioSizeBytes: Size64;
}

export interface FabricDessertBoardConfig {
  platformName: string;
  boardRevision: string;
  cpuTopology: Frt64TopologyConfig;
  memoryLayout: MemoryLayoutConfig;
}

export const DEFAULT_FABRIC_DESSERT_CONFIG: FabricDessertBoardConfig = {
  platformName: 'Fabric Dessert',
  boardRevision: 'rev-0.1.0',
  cpuTopology: {
    coreCount: 4,
    clusters: 1,
    defaultFamily: Frt64ExecutionFamily.ARM_64,
  },
  memoryLayout: {
    // 0x0000_0000 -> 0x7FFF_FFFF: 2 GiB configurable default RAM
    ramBase: 0x00000000n,
    ramSizeBytes: 0x80000000n, // 2 GiB
    // 0x8000_0000 -> 0xFFFF_FFFF: 2 GiB MMIO window
    mmioBase: 0x80000000n,
    mmioSizeBytes: 0x80000000n, // 2 GiB
  },
};
