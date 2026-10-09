import {describe, it, expect} from 'vitest';
import {
  assertValidAddress64,
  BootRom,
  createFabricDessertInstance,
  DeviceClass,
  Frt64ExecutionFamily,
  IDevice,
  IDeviceContext,
  isValidAddress64,
  MemoryRegionType,
  PhysicalAddressSpace,
  RuntimeLifecycleState,
  SparsePhysicalMemoryRegion,
  toAddress64,
} from './index';

describe('Fabric Dessert Core Foundation', () => {
  it('instantiates Fabric Dessert with configurable topology and default state', () => {
    const instance = createFabricDessertInstance({
      cpuTopology: {
        coreCount: 8,
        defaultFamily: Frt64ExecutionFamily.ARM_64,
      },
      bootContract: {
        bootRomBase: 0x00000000n,
        bootRomSizeBytes: 0x00100000n,
        resetVector: 0x00000000n,
      },
      memoryLayout: {
        ramBase: 0x00100000n,
        ramSizeBytes: 0x100000000n, // 4 GiB
        mmioBase: 0x200000000n,
        mmioSizeBytes: 0x100000000n, // 4 GiB
      },
    });

    expect(instance.board.config.platformName).toBe('Fabric Dessert');
    expect(instance.cpu.coreCount).toBe(8);
    expect(instance.cpu.defaultFamily).toBe(Frt64ExecutionFamily.ARM_64);
    expect(instance.getState()).toBe(RuntimeLifecycleState.CONFIGURED);
  });

  it('manages runtime lifecycle states correctly', () => {
    const instance = createFabricDessertInstance();
    expect(instance.getState()).toBe(RuntimeLifecycleState.CONFIGURED);

    instance.initialize();
    expect(instance.getState()).toBe(RuntimeLifecycleState.READY);

    instance.start();
    expect(instance.getState()).toBe(RuntimeLifecycleState.RUNNING);

    instance.pause();
    expect(instance.getState()).toBe(RuntimeLifecycleState.PAUSED);

    instance.resume();
    expect(instance.getState()).toBe(RuntimeLifecycleState.RUNNING);

    instance.stop();
    expect(instance.getState()).toBe(RuntimeLifecycleState.STOPPED);
  });

  it('exposes FRT64 execution family metadata and rejects fake mode transitions without execution engine', () => {
    const instance = createFabricDessertInstance();
    const core0 = instance.cpu.getCore(0);
    expect(core0).toBeDefined();

    expect(core0?.getActiveFamily()).toBe(Frt64ExecutionFamily.ARM_64);

    // No-op switch to the already-active family returns true
    expect(core0?.switchExecutionFamily(Frt64ExecutionFamily.ARM_64)).toBe(true);

    // Attempting architectural transitions without an attached execution engine is rejected
    expect(core0?.switchExecutionFamily(Frt64ExecutionFamily.ARM_32)).toBe(false);
    expect(core0?.getActiveFamily()).toBe(Frt64ExecutionFamily.ARM_64);

    expect(core0?.switchExecutionFamily(Frt64ExecutionFamily.X86_64)).toBe(false);
    expect(core0?.getActiveFamily()).toBe(Frt64ExecutionFamily.ARM_64);

    expect(core0?.switchExecutionFamily(Frt64ExecutionFamily.X86_32)).toBe(false);
    expect(core0?.getActiveFamily()).toBe(Frt64ExecutionFamily.ARM_64);
  });

  it('dispatches memory reads and writes through configurable 64-bit address space', () => {
    const instance = createFabricDessertInstance();
    const mem = instance.memory;

    mem.write32(0x00101000n, 0x12345678);
    expect(mem.read32(0x00101000n)).toBe(0x12345678);

    mem.write64(0x00102000n, 0x0123456789abcdefn);
    expect(mem.read64(0x00102000n)).toBe(0x0123456789abcdefn);
  });

  it('registers devices and routes MMIO and interrupts dynamically', () => {
    const instance = createFabricDessertInstance();

    let mmioWrittenVal = 0n;
    let initialized = false;
    let resetCount = 0;
    let terminated = false;

    const testDevice: IDevice = {
      id: 'dev_test',
      name: 'Test Peripheral',
      deviceClass: DeviceClass.GENERIC,
      irqCount: 1,
      mmioRequests: [
        {
          name: 'regs',
          size: 4096n,
          handler: {
            read: () => 0xaabbccddn,
            write: (_offset, value) => {
              void _offset;
              mmioWrittenVal = value;
            },
          },
        },
      ],
      initialize: (_ctx: IDeviceContext) => {
        void _ctx;
        initialized = true;
      },
      reset: () => {
        resetCount++;
      },
      terminate: () => {
        terminated = true;
      },
    };

    const regRecord = instance.deviceBus.registerDevice(testDevice);
    expect(initialized).toBe(true);
    expect(resetCount).toBe(0);
    expect(terminated).toBe(false);
    const mmioBase = regRecord.mmioAllocations.get('regs');
    expect(mmioBase).toBeDefined();
    if (mmioBase !== undefined) {
      expect(instance.memory.read32(mmioBase)).toBe(0xaabbccdd);
      instance.memory.write32(mmioBase, 0x55aa55aa);
      expect(mmioWrittenVal).toBe(0x55aa55aan);
    }
  });

  describe('Fabric Dessert Display Subsystem', () => {
    it('initializes framebuffer with exact 1080x2424 RGBA8888 geometry', () => {
      const instance = createFabricDessertInstance();
      const display = instance.board.displayDevice;
      const fb = display.framebuffer;

      expect(fb.width).toBe(1080);
      expect(fb.height).toBe(2424);
      expect(fb.strideBytes).toBe(4320);
      expect(fb.sizeBytes).toBe(10471680);
      expect(fb.getPixelBuffer().length).toBe(10471680);
    });

    it('enforces deterministic 1:1 pixel mapping in framebuffer', () => {
      const instance = createFabricDessertInstance();
      const fb = instance.board.displayDevice.framebuffer;

      // Write pixel at (100, 200)
      fb.writePixel(100, 200, 255, 128, 64, 255);
      expect(fb.isDirty()).toBe(true);

      const pixelVal = fb.readPixel(100, 200);
      expect(pixelVal).toBe(((255 << 24) | (128 << 16) | (64 << 8) | 255) >>> 0);

      // Verify raw byte buffer at exact 1:1 offset: (200 * 1080 + 100) * 4 = 864400
      const rawOffset = (200 * 1080 + 100) * 4;
      const rawBuf = fb.getPixelBuffer();
      expect(rawBuf[rawOffset]).toBe(255);
      expect(rawBuf[rawOffset + 1]).toBe(128);
      expect(rawBuf[rawOffset + 2]).toBe(64);
      expect(rawBuf[rawOffset + 3]).toBe(255);
    });

    it('routes frame submission from SystemRenderer to output backend deterministically', () => {
      const instance = createFabricDessertInstance();
      const display = instance.board.displayDevice;
      const renderer = display.systemRenderer;

      let presentCallCount = 0;
      let lastPresentedPixel = 0;

      const mockBackend = {
        targetWidth: 1080,
        targetHeight: 2424,
        present: (framebuffer: typeof display.framebuffer) => {
          presentCallCount++;
          lastPresentedPixel = framebuffer.readPixel(0, 0);
        },
      };

      renderer.attachOutputBackend(mockBackend);
      // Initial attach presents once to sync
      expect(presentCallCount).toBe(1);

      // Write a pixel and render frame
      display.framebuffer.writePixel(0, 0, 10, 20, 30, 255);
      const rendered = renderer.renderFrame();
      expect(rendered).toBe(true);
      expect(presentCallCount).toBe(2);
      expect(lastPresentedPixel).toBe(((10 << 24) | (20 << 16) | (30 << 8) | 255) >>> 0);

      // Second render with no modifications should not re-present
      expect(renderer.renderFrame()).toBe(false);
      expect(presentCallCount).toBe(2);
    });

    it('allows CPU / bus memory access to display controller MMIO apertures', () => {
      const instance = createFabricDessertInstance();
      const display = instance.board.displayDevice;

      const record = instance.deviceBus.listDevices().find(
        (r) => r.device.id === display.id
      );
      expect(record).toBeDefined();

      const ctrlBase = record?.mmioAllocations.get('ctrl');
      const fbBase = record?.mmioAllocations.get('fb');
      expect(ctrlBase).toBeDefined();
      expect(fbBase).toBeDefined();

      if (ctrlBase !== undefined && fbBase !== undefined) {
        // Read MAGIC ("FDIS" -> 0x53494446)
        const magic = instance.memory.read32(ctrlBase);
        expect(magic).toBe(0x53494446);

        // Read WIDTH (1080) and HEIGHT (2424)
        expect(instance.memory.read32(ctrlBase + 4n)).toBe(1080);
        expect(instance.memory.read32(ctrlBase + 8n)).toBe(2424);

        // Write directly to framebuffer aperture via memory space
        instance.memory.write32(fbBase, 0x11223344);
        const readBack = instance.memory.read32(fbBase);
        expect(readBack).toBe(0x11223344);
      }
    });

    it('verifies font_sun_8x16 as default bootloader/kernel font', async () => {
      const instance = createFabricDessertInstance();
      const fb = instance.board.displayDevice.framebuffer;
      const {font_sun_8x16, DEFAULT_BOOT_FONT} = await import('./display/font-sun8x16');

      expect(DEFAULT_BOOT_FONT).toBe(font_sun_8x16);
      expect(font_sun_8x16.name).toBe('font_sun_8x16');
      expect(font_sun_8x16.width).toBe(8);
      expect(font_sun_8x16.height).toBe(16);
      expect(font_sun_8x16.charCount).toBe(256);
      expect(font_sun_8x16.data.length).toBe(4096);

      // Glyph for 'A' (65) should have 16 bytes
      const glyphA = font_sun_8x16.getGlyph(65);
      expect(glyphA.length).toBe(16);

      // Render string to framebuffer
      font_sun_8x16.drawString(fb, 0, 0, 'reachOS', 255, 255, 255, 255, 0, 0, 0, 255);
      expect(fb.isDirty()).toBe(true);

      // Ensure pixels were modified in the 8x16 cell area
      let nonZeroCount = 0;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 8 * 7; x++) {
          if (fb.readPixel(x, y) !== 0) {
            nonZeroCount++;
          }
        }
      }
      expect(nonZeroCount).toBeGreaterThan(0);
    });
  });

  describe('Fabric Dessert Minimum Boot Substrate', () => {
    it('1. maps Boot ROM into physical address space with configured bounds', () => {
      const instance = createFabricDessertInstance();
      const bootRom = instance.board.bootRom;
      const mem = instance.memory;

      expect(bootRom.id).toBe('bootrom');
      expect(bootRom.baseAddress).toBe(instance.board.bootContract.bootRomBase);
      expect(bootRom.size).toBe(instance.board.bootContract.bootRomSizeBytes);

      const regionAtBase = mem.getRegionAt(bootRom.baseAddress);
      expect(regionAtBase?.id).toBe('bootrom');
    });

    it('2. guarantees Boot ROM is immutable at runtime (writes rejected, no runtime payload mutation API)', () => {
      const instance = createFabricDessertInstance();
      const mem = instance.memory;
      const bootBase = instance.board.bootContract.bootRomBase;

      // Writing to Boot ROM throws permission error
      expect(() => {
        mem.write32(bootBase, 0x12345678);
      }).toThrow(/read-only/i);

      expect(() => {
        mem.write8(bootBase, 0xff);
      }).toThrow(/read-only/i);

      // Verify no runtime loadPayload method is exposed on IBootRom
      const romObj = instance.board.bootRom as unknown as Record<string, unknown>;
      expect(romObj['loadPayload']).toBeUndefined();
    });

    it('3. verifies Boot ROM reads work correctly', () => {
      const testPayload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
      const instance = createFabricDessertInstance({
        bootContract: {
          bootRomBase: 0x00000000n,
          bootRomSizeBytes: 0x00100000n,
          resetVector: 0x00000000n,
          initialPayload: testPayload,
        },
      });

      const mem = instance.memory;
      expect(mem.read8(0x00000000n)).toBe(0xaa);
      expect(mem.read8(0x00000001n)).toBe(0xbb);
      expect(mem.read32(0x00000000n)).toBe(0xddccbbaa);

      const bytes = mem.readBytes(0x00000000n, 4);
      expect(bytes).toEqual(testPayload);
    });

    it('4. verifies physical instruction fetch requires execute permission and succeeds on executable Boot ROM', () => {
      const testPayload = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
      const instance = createFabricDessertInstance({
        bootContract: {
          bootRomBase: 0x00000000n,
          bootRomSizeBytes: 0x00100000n,
          resetVector: 0x00000000n,
          initialPayload: testPayload,
        },
      });

      const fetched = instance.memory.fetchInstructionBytes(0x00000000n, 4);
      expect(fetched).toEqual(testPayload);
    });

    it('5. faults when attempting to fetch instructions from non-executable memory or MMIO', () => {
      const instance = createFabricDessertInstance();
      const mem = instance.memory;

      // Map a non-executable test region
      const nonExecRegion = new SparsePhysicalMemoryRegion(
        'no_exec_data',
        'Non-Executable Data Buffer',
        0x300000000n,
        4096n,
        MemoryRegionType.RAM,
        {read: true, write: true, execute: false}
      );
      mem.mapRegion(nonExecRegion);

      // Fetching from non-executable region must fault
      expect(() => {
        mem.fetchInstructionBytes(0x300000000n, 4);
      }).toThrow(/execute permission/i);

      // Fetching from MMIO range must also fault
      const mmioBase = instance.board.config.memoryLayout.mmioBase;
      expect(() => {
        mem.fetchInstructionBytes(mmioBase, 4);
      }).toThrow(/not executable/i);

      // Fetching from unmapped address must fault
      expect(() => {
        mem.fetchInstructionBytes(0x999900000000n, 4);
      }).toThrow(/unmapped/i);
    });

    it('6. reset places only the configured primary boot CPU at the board reset entry', () => {
      const customResetVector = 0x00000100n;
      const instance = createFabricDessertInstance({
        cpuTopology: {
          coreCount: 4,
          primaryCoreId: 0,
          defaultFamily: Frt64ExecutionFamily.ARM_64,
        },
        bootContract: {
          bootRomBase: 0x00000000n,
          bootRomSizeBytes: 0x00100000n,
          resetVector: customResetVector,
        },
      });

      instance.board.reset();

      const primary = instance.cpu.getPrimaryCore();
      expect(primary.coreId).toBe(0);
      expect(primary.isPrimary).toBe(true);
      expect(primary.pc).toBe(customResetVector);
      expect(primary.resetVector).toBe(customResetVector);
      expect(primary.getStatus().runState).toBe('RESET');
    });

    it('7. secondary CPUs remain held/parked on reset until a future CPU bring-up mechanism exists', () => {
      const instance = createFabricDessertInstance({
        cpuTopology: {
          coreCount: 4,
          primaryCoreId: 0,
          defaultFamily: Frt64ExecutionFamily.ARM_64,
        },
      });

      instance.board.reset();

      const secondaries = instance.cpu.getSecondaryCores();
      expect(secondaries.length).toBe(3);

      for (const sec of secondaries) {
        expect(sec.isPrimary).toBe(false);
        expect(sec.getStatus().runState).toBe('PARKED');
      }

      // Starting the instance resumes only the primary boot CPU
      instance.initialize();
      instance.start();

      expect(instance.cpu.getPrimaryCore().getStatus().runState).toBe('RUNNING');
      for (const sec of secondaries) {
        expect(sec.getStatus().runState).toBe('PARKED');
      }
    });

    it('8. verifies byte-fetch boundary for an explicitly requested number of raw bytes', () => {
      const testBytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
      const instance = createFabricDessertInstance({
        bootContract: {
          bootRomBase: 0x00000000n,
          bootRomSizeBytes: 0x00100000n,
          resetVector: 0x00000000n,
          initialPayload: testBytes,
        },
      });

      instance.board.reset();
      const primary = instance.cpu.getPrimaryCore();

      // Explicitly fetch 2 bytes
      const fetch2 = primary.fetchInstructionBytes(2);
      expect(fetch2.success).toBe(true);
      expect(fetch2.sizeBytes).toBe(2);
      expect(fetch2.bytes).toEqual(new Uint8Array([0x12, 0x34]));

      // Explicitly fetch 6 bytes
      const fetch6 = primary.fetchInstructionBytes(6);
      expect(fetch6.success).toBe(true);
      expect(fetch6.sizeBytes).toBe(6);
      expect(fetch6.bytes).toEqual(testBytes);
    });

    it('9. step() does NOT decode or execute instructions without an execution engine', () => {
      const instance = createFabricDessertInstance();
      instance.board.reset();

      const primary = instance.cpu.getPrimaryCore();
      const stepResult = primary.step();

      expect(stepResult.executed).toBe(false);
      expect(stepResult.reason).toBe('NO_EXECUTION_ENGINE_ATTACHED');
    });

    it('12. ensures large configured Boot ROM sizes are not silently truncated', () => {
      // Configure a 128 MiB Boot ROM (larger than previous 64 MiB cap)
      const rom128MB = 128n * 1024n * 1024n; // 0x0800_0000n

      const instance = createFabricDessertInstance({
        bootContract: {
          bootRomBase: 0x00000000n,
          bootRomSizeBytes: rom128MB,
          resetVector: 0x00000000n,
        },
        memoryLayout: {
          ramBase: rom128MB,
          ramSizeBytes: 0x40000000n, // 1 GiB RAM
          mmioBase: 0x80000000n,
          mmioSizeBytes: 0x80000000n,
        },
      });

      const bootRom = instance.board.bootRom;
      expect(bootRom.size).toBe(rom128MB);

      // Sparse backing handles offsets beyond 64 MiB without truncation
      const offsetAt100MB = 100n * 1024n * 1024n;
      expect(bootRom.read8(offsetAt100MB)).toBe(0);

      // Verify physical address space resolves the entire 128 MiB range
      const endOffset = rom128MB - 4n;
      expect(instance.memory.read32(endOffset)).toBe(0);
    });

    it('13. guarantees 64-bit safe sparse memory storage at high addresses above Number.MAX_SAFE_INTEGER within 64-bit address space', () => {
      // Number.MAX_SAFE_INTEGER is (2^53 - 1) = 9007199254740991n.
      // In the 64-bit physical address space [0, 0xFFFF_FFFF_FFFF_FFFFn], choose a valid
      // high address well above Number.MAX_SAFE_INTEGER near the upper end of the 64-bit space:
      const highAddress = 0xffff_ffff_0000_0000n;
      expect(highAddress > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(highAddress <= 0xffff_ffff_ffff_ffffn).toBe(true);

      const regionSize = 131072n; // 128 KiB (2 x 64 KiB pages)
      const highRegion = new SparsePhysicalMemoryRegion(
        'high_mem',
        'High Physical Memory',
        highAddress,
        regionSize,
        MemoryRegionType.RAM,
        {read: true, write: true, execute: true}
      );

      // Write distinct values at adjacent 64-bit safe offsets across pages
      highRegion.write32(0n, 0xdeadbeef);
      highRegion.write32(65536n, 0xcafebabe);

      expect(highRegion.read32(0n)).toBe(0xdeadbeef);
      expect(highRegion.read32(65536n)).toBe(0xcafebabe);

      // Verify unallocated offset reads zero
      expect(highRegion.read32(4n)).toBe(0);

      // Also map into PhysicalAddressSpace and verify full 64-bit address resolution
      const mem = new PhysicalAddressSpace();
      mem.mapRegion(highRegion);

      expect(mem.read32(highAddress)).toBe(0xdeadbeef);
      expect(mem.read32(highAddress + 65536n)).toBe(0xcafebabe);
      expect(mem.read32(highAddress + 4n)).toBe(0);

      // Write through address space at high 64-bit address
      mem.write32(highAddress + 8n, 0x11223344);
      expect(mem.read32(highAddress + 8n)).toBe(0x11223344);
    });

    it('14. preserves PARKED secondary CPUs across runtime pause and resume', () => {
      const instance = createFabricDessertInstance({
        cpuTopology: {
          coreCount: 4,
          primaryCoreId: 0,
          defaultFamily: Frt64ExecutionFamily.ARM_64,
        },
      });

      instance.initialize();
      expect(instance.cpu.getPrimaryCore().getStatus().runState).toBe('RESET');
      for (const sec of instance.cpu.getSecondaryCores()) {
        expect(sec.getStatus().runState).toBe('PARKED');
      }

      // Start: Primary enters RUNNING, Secondaries remain PARKED
      instance.start();
      expect(instance.cpu.getPrimaryCore().getStatus().runState).toBe('RUNNING');
      for (const sec of instance.cpu.getSecondaryCores()) {
        expect(sec.getStatus().runState).toBe('PARKED');
      }

      // Pause: Primary enters PAUSED (NOT HALTED), Secondaries remain PARKED (NOT HALTED)
      instance.pause();
      expect(instance.cpu.getPrimaryCore().getStatus().runState).toBe('PAUSED');
      for (const sec of instance.cpu.getSecondaryCores()) {
        expect(sec.getStatus().runState).toBe('PARKED');
      }

      // Resume: Primary returns to RUNNING, Secondaries remain PARKED
      instance.resume();
      expect(instance.cpu.getPrimaryCore().getStatus().runState).toBe('RUNNING');
      for (const sec of instance.cpu.getSecondaryCores()) {
        expect(sec.getStatus().runState).toBe('PARKED');
      }
    });

    it('15. validates primary CPU topology during construction and rejects invalid primaryCoreId', () => {
      // primaryCoreId < 0 must throw
      expect(() => {
        createFabricDessertInstance({
          cpuTopology: {
            coreCount: 4,
            primaryCoreId: -1,
            defaultFamily: Frt64ExecutionFamily.ARM_64,
          },
        });
      }).toThrow(/Invalid primaryCoreId/i);

      // primaryCoreId >= coreCount must throw
      expect(() => {
        createFabricDessertInstance({
          cpuTopology: {
            coreCount: 4,
            primaryCoreId: 4,
            defaultFamily: Frt64ExecutionFamily.ARM_64,
          },
        });
      }).toThrow(/Invalid primaryCoreId/i);
    });

    it('16. provides controlled secondary CPU release boundary without fake bring-up execution', () => {
      const instance = createFabricDessertInstance({
        cpuTopology: {
          coreCount: 4,
          primaryCoreId: 0,
          defaultFamily: Frt64ExecutionFamily.ARM_64,
        },
      });

      instance.board.reset();

      // Primary core cannot be released as a secondary
      expect(instance.cpu.releaseSecondaryCore(0)).toBe(false);

      // Non-existent core cannot be released
      expect(instance.cpu.releaseSecondaryCore(99)).toBe(false);

      // Release secondary core 1: transitions from PARKED to RESET
      const secondaryCore1 = instance.cpu.getCore(1);
      expect(secondaryCore1?.getStatus().runState).toBe('PARKED');

      const released = instance.cpu.releaseSecondaryCore(1, 0x00000200n);
      expect(released).toBe(true);
      expect(secondaryCore1?.getStatus().runState).toBe('RESET');
      expect(secondaryCore1?.pc).toBe(0x00000200n);

      // Attempting to release an already-released core returns false
      expect(instance.cpu.releaseSecondaryCore(1)).toBe(false);

      // Core 2 and 3 remain PARKED
      expect(instance.cpu.getCore(2)?.getStatus().runState).toBe('PARKED');
      expect(instance.cpu.getCore(3)?.getStatus().runState).toBe('PARKED');
    });

    it('17. enforces Address64 range [0, 0xFFFF_FFFF_FFFF_FFFFn] and validates toAddress64 helper', () => {
      // Valid Address64 values
      expect(toAddress64(0)).toBe(0n);
      expect(toAddress64(0n)).toBe(0n);
      expect(toAddress64('0')).toBe(0n);
      expect(toAddress64(0xffff_ffff_ffff_ffffn)).toBe(0xffff_ffff_ffff_ffffn);
      expect(toAddress64('0xffffffffffffffff')).toBe(0xffff_ffff_ffff_ffffn);

      expect(isValidAddress64(0n)).toBe(true);
      expect(isValidAddress64(0xffff_ffff_ffff_ffffn)).toBe(true);
      expect(isValidAddress64(0x8000_0000_0000_0000n)).toBe(true);

      // Safe integer number input is accepted
      expect(toAddress64(Number.MAX_SAFE_INTEGER)).toBe(
        BigInt(Number.MAX_SAFE_INTEGER)
      );

      // Unsafe integer number inputs are rejected immediately with invalid address number value
      expect(() => toAddress64(Number.MAX_SAFE_INTEGER + 1)).toThrow(
        /invalid address number value/i
      );
      expect(() => toAddress64(Number.MAX_SAFE_INTEGER + 2)).toThrow(
        /invalid address number value/i
      );

      // Verify Number precision restriction does not infringe upon string or bigint exact precision
      expect(toAddress64(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBe(
        BigInt(Number.MAX_SAFE_INTEGER) + 1n
      );
      expect(toAddress64(String(BigInt(Number.MAX_SAFE_INTEGER) + 1n))).toBe(
        BigInt(Number.MAX_SAFE_INTEGER) + 1n
      );
      expect(toAddress64(0x10_0000_0000_0000n)).toBe(0x10_0000_0000_0000n);
      expect(toAddress64('0x10000000000000')).toBe(0x10_0000_0000_0000n);

      // Non-integer numbers (floats, NaN, Infinity) are rejected
      expect(() => toAddress64(1.5)).toThrow(/invalid address number value/i);
      expect(() => toAddress64(NaN)).toThrow(/invalid address number value/i);
      expect(() => toAddress64(Infinity)).toThrow(/invalid address number value/i);

      // Invalid negative addresses rejected
      expect(() => toAddress64(-1)).toThrow(/out of 64-bit physical address range/i);
      expect(() => toAddress64(-1n)).toThrow(/out of 64-bit physical address range/i);
      expect(() => toAddress64('-1')).toThrow(/out of 64-bit physical address range/i);
      expect(isValidAddress64(-1n)).toBe(false);
      expect(() => assertValidAddress64(-1n)).toThrow(/out of 64-bit physical address range/i);

      // Invalid addresses exceeding 2^64 - 1 rejected
      expect(() => toAddress64(0x1_0000_0000_0000_0000n)).toThrow(/out of 64-bit physical address range/i);
      expect(() => toAddress64('0x10000000000000000')).toThrow(/out of 64-bit physical address range/i);
      expect(isValidAddress64(0x1_0000_0000_0000_0000n)).toBe(false);
      expect(() => assertValidAddress64(0x1_0000_0000_0000_0000n)).toThrow(/out of 64-bit physical address range/i);
    });

    it('18. rejects memory region and MMIO creation/mapping when boundary extends beyond 0xFFFF_FFFF_FFFF_FFFFn', () => {
      const mem = new PhysicalAddressSpace();

      // Negative base address rejected
      expect(() => {
        new SparsePhysicalMemoryRegion(
          'neg_base',
          'Negative Base',
          -1n,
          4096n,
          MemoryRegionType.RAM,
          {read: true, write: true, execute: true}
        );
      }).toThrow(/out of 64-bit physical address range/i);

      // Base address exceeding 64-bit range rejected
      expect(() => {
        new SparsePhysicalMemoryRegion(
          'overflow_base',
          'Overflow Base',
          0x1_0000_0000_0000_0000n,
          4096n,
          MemoryRegionType.RAM,
          {read: true, write: true, execute: true}
        );
      }).toThrow(/out of 64-bit physical address range/i);

      // Region extending beyond 0xFFFF_FFFF_FFFF_FFFFn rejected
      expect(() => {
        new SparsePhysicalMemoryRegion(
          'overflow_end',
          'Overflow End',
          0xffff_ffff_ffff_0000n,
          0x20000n, // extends beyond 0xFFFF_FFFF_FFFF_FFFFn
          MemoryRegionType.RAM,
          {read: true, write: true, execute: true}
        );
      }).toThrow(/exceeds 64-bit physical address space limit/i);

      // Boot ROM extending beyond 0xFFFF_FFFF_FFFF_FFFFn rejected
      expect(() => {
        new BootRom(0xffff_ffff_ffff_0000n, 0x20000n);
      }).toThrow(/exceeds 64-bit physical address space limit/i);

      // MMIO mapping extending beyond 0xFFFF_FFFF_FFFF_FFFFn rejected
      expect(() => {
        mem.mapMMIO({
          id: 'bad_mmio',
          name: 'Bad MMIO',
          baseAddress: 0xffff_ffff_ffff_0000n,
          size: 0x20000n,
          handler: {
            read: () => 0n,
            write: (_offset, _val) => {
              void _offset;
              void _val;
            },
          },
        });
      }).toThrow(/exceeds 64-bit physical address space limit/i);
    });

    it('19. rejects physical access and instruction fetches outside 64-bit address space or extending beyond limit', () => {
      const mem = new PhysicalAddressSpace();

      // Negative address rejected
      expect(() => mem.read8(-1n)).toThrow(/out of 64-bit physical address range/i);
      expect(() => mem.write8(-1n, 0)).toThrow(/out of 64-bit physical address range/i);
      expect(() => mem.fetchInstructionBytes(-1n, 4)).toThrow(/out of 64-bit physical address range/i);

      // Address exceeding 64-bit limit rejected
      expect(() => mem.read8(0x1_0000_0000_0000_0000n)).toThrow(/out of 64-bit physical address range/i);
      expect(() => mem.write8(0x1_0000_0000_0000_0000n, 0)).toThrow(/out of 64-bit physical address range/i);
      expect(() => mem.fetchInstructionBytes(0x1_0000_0000_0000_0000n, 4)).toThrow(/out of 64-bit physical address range/i);

      // Access at near-top address where byte count extends beyond 0xFFFF_FFFF_FFFF_FFFFn
      expect(() => mem.read32(0xffff_ffff_ffff_fffdn)).toThrow(/exceeds 64-bit physical address space limit/i);
      expect(() => mem.write32(0xffff_ffff_ffff_fffdn, 0)).toThrow(/exceeds 64-bit physical address space limit/i);
      expect(() => mem.fetchInstructionBytes(0xffff_ffff_ffff_fffdn, 4)).toThrow(/exceeds 64-bit physical address space limit/i);
    });
  });
});
