import {describe, it, expect} from 'vitest';
import {
  createFabricDessertInstance,
  DeviceClass,
  Frt64ExecutionFamily,
  IDevice,
  IDeviceContext,
  RuntimeLifecycleState,
} from './index';

describe('Fabric Dessert Core Foundation', () => {
  it('instantiates Fabric Dessert with configurable topology and default state', () => {
    const instance = createFabricDessertInstance({
      cpuTopology: {
        coreCount: 8,
        defaultFamily: Frt64ExecutionFamily.ARM_64,
      },
      memoryLayout: {
        ramBase: 0x00000000n,
        ramSizeBytes: 0x100000000n, // 4 GiB
        mmioBase: 0x100000000n,
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

  it('provides FRT64 execution family boundary contracts without fake ISA simulation', () => {
    const instance = createFabricDessertInstance();
    const core0 = instance.cpu.getCore(0);
    expect(core0).toBeDefined();

    expect(core0?.getActiveFamily()).toBe(Frt64ExecutionFamily.ARM_64);

    // Switch across supported execution families
    expect(core0?.switchExecutionFamily(Frt64ExecutionFamily.ARM_32)).toBe(true);
    expect(core0?.getActiveFamily()).toBe(Frt64ExecutionFamily.ARM_32);

    expect(core0?.switchExecutionFamily(Frt64ExecutionFamily.X86_64)).toBe(true);
    expect(core0?.getActiveFamily()).toBe(Frt64ExecutionFamily.X86_64);

    expect(core0?.switchExecutionFamily(Frt64ExecutionFamily.X86_32)).toBe(true);
    expect(core0?.getActiveFamily()).toBe(Frt64ExecutionFamily.X86_32);
  });

  it('dispatches memory reads and writes through configurable 64-bit address space', () => {
    const instance = createFabricDessertInstance();
    const mem = instance.memory;

    mem.write32(0x1000n, 0x12345678);
    expect(mem.read32(0x1000n)).toBe(0x12345678);

    mem.write64(0x2000n, 0x0123456789abcdefn);
    expect(mem.read64(0x2000n)).toBe(0x0123456789abcdefn);
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
  });
});
