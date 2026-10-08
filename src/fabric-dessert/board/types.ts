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

/**
 * Fabric Dessert Platform Boot Contract.
 *
 * NOTE: The default configuration maps Boot ROM at 0x00000000 and places the reset vector
 * at 0x00000000. This is strictly a Fabric Dessert board/platform interconnect contract,
 * NOT an ARM architectural reset rule, an x86 reset rule, or an OS boot protocol requirement.
 * Specific CPU architectures and operating systems will map to this via dedicated platform layers.
 */
export interface FabricDessertBootContract {
  readonly bootRomBase: Address64;
  readonly bootRomSizeBytes: Size64;
  readonly resetVector: Address64;
  readonly initialPayload?: Uint8Array;
}

export interface FabricDessertBoardConfig {
  platformName: string;
  boardRevision: string;
  cpuTopology: Frt64TopologyConfig;
  memoryLayout: MemoryLayoutConfig;
  bootContract: FabricDessertBootContract;
}

export const DEFAULT_FABRIC_DESSERT_CONFIG: FabricDessertBoardConfig = {
  platformName: 'Fabric Dessert',
  boardRevision: 'rev-0.1.0',
  cpuTopology: {
    coreCount: 4,
    clusters: 1,
    defaultFamily: Frt64ExecutionFamily.ARM_64,
    defaultResetVector: 0x00000000n,
  },
  memoryLayout: {
    ramBase: 0x00100000n,
    ramSizeBytes: 0x7ff00000n, // 2 GiB - 1 MiB
    mmioBase: 0x80000000n,
    mmioSizeBytes: 0x80000000n, // 2 GiB
  },
  bootContract: {
    bootRomBase: 0x00000000n,
    bootRomSizeBytes: 0x00100000n, // 1 MiB Boot ROM
    resetVector: 0x00000000n,
  },
};
