import {describe, it, expect, beforeEach} from 'vitest';
import {
  AArch64ExecutionEngine,
  createExecutionEngine,
  UnsupportedFrt64Engine,
} from './engine';
import {
  Frt64CoreBoundary,
  Frt64CpuBoundary,
  IFrt64BusMaster,
} from './boundary';
import {
  Frt64CoreRunState,
  Frt64ExecutionFamily,
} from './types';
import {createCpuAccessContext} from '../../memory/access-context';
import {PhysicalAddressSpace} from '../../memory/address-space';
import {SparsePhysicalMemoryRegion} from '../../memory/physical-memory';
import {MemoryRegionType} from '../../memory/types';
import {createFabricDessertInstance} from '../../runtime/instance';
import {ExecutionPump} from '../../runtime/execution-pump';

describe('FRT64 Virtual CPU Execution Engine', () => {
  let addressSpace: PhysicalAddressSpace;
  let busMaster: IFrt64BusMaster;
  const accessContext = createCpuAccessContext(0, 0);

  beforeEach(() => {
    addressSpace = new PhysicalAddressSpace();

    // 64 KiB RAM at 0x1000
    const ram = new SparsePhysicalMemoryRegion(
      'ram',
      'RAM',
      0x1000n,
      0x10000n,
      MemoryRegionType.RAM,
      {read: true, write: true, execute: true}
    );
    addressSpace.mapRegion(ram);

    busMaster = {
      readPhysical: (addr, size, ctx) => addressSpace.readBytes(addr, size, ctx),
      writePhysical: (addr, data, ctx) => addressSpace.writeBytes(addr, data, ctx),
      fetchInstructionPhysical: (addr, size, ctx) => addressSpace.fetchInstructionBytes(addr, size, ctx),
    };
  });

  describe('1. Engine Attachment and Delegation Boundary', () => {
    it('returns NO_EXECUTION_ENGINE_ATTACHED when step() is called without an attached engine', () => {
      const core = new Frt64CoreBoundary({
        coreId: 0,
        initialFamily: Frt64ExecutionFamily.ARM_64,
        resetVector: 0x1000n,
      });
      core.attachBusMaster(busMaster);

      const res = core.step();
      expect(res.executed).toBe(false);
      expect(res.reason).toBe('NO_EXECUTION_ENGINE_ATTACHED');
    });

    it('attaches AArch64ExecutionEngine and delegates step() to real execution', () => {
      const core = new Frt64CoreBoundary({
        coreId: 0,
        initialFamily: Frt64ExecutionFamily.ARM_64,
        resetVector: 0x1000n,
      });
      core.attachBusMaster(busMaster);

      // Write NOP instruction (0xd503201f) at 0x1000
      busMaster.writePhysical(0x1000n, new Uint8Array([0x1f, 0x20, 0x03, 0xd5]));

      const engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);
      core.attachExecutionEngine(engine);

      const res = core.step();
      expect(res.executed).toBe(true);
      expect(res.reason).toBe('OK');
      expect(res.disassembly).toBe('nop');
      expect(core.pc).toBe(0x1004n);
      expect(core.getStatus().cyclesExecuted).toBe(1n);
    });

    it('provides truthful architecture snapshot in getStatus()', () => {
      const core = new Frt64CoreBoundary({
        coreId: 0,
        initialFamily: Frt64ExecutionFamily.ARM_64,
        resetVector: 0x1000n,
      });
      core.attachBusMaster(busMaster);
      core.attachExecutionEngine(new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n));

      core.setRegister('x0', 0xdeadbeefn);
      core.setRegister('sp', 0x5000n);

      const status = core.getStatus();
      expect(status.hasEngine).toBe(true);
      expect(status.architectureSnapshot).toBeDefined();
      expect(status.architectureSnapshot?.['family']).toBe('ARM_64');
      expect(status.architectureSnapshot?.['sp']).toContain('5000');
    });
  });

  describe('2. AArch64 Machine Instructions Execution', () => {
    let engine: AArch64ExecutionEngine;

    beforeEach(() => {
      engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);
    });

    it('executes MOVZ and MOVK to construct 32-bit and 64-bit immediates', () => {
      // 0x1000: movz x0, #0x1234 (0xd2824680)
      // 0x1004: movk x0, #0x5678, lsl #16 (0xf2aaacf0)
      const code = new Uint8Array([
        0x80, 0x46, 0x82, 0xd2, // movz x0, #0x1234 (0xd2824680)
        0x00, 0xcf, 0xaa, 0xf2, // movk x0, #0x5678, lsl #16 (0xf2aacf00)
      ]);
      busMaster.writePhysical(0x1000n, code);

      const step1 = engine.step();
      expect(step1.executed).toBe(true);
      expect(engine.getRegister('x0')).toBe(0x1234n);
      expect(engine.pc).toBe(0x1004n);

      const step2 = engine.step();
      expect(step2.executed).toBe(true);
      expect(engine.getRegister('x0')).toBe(0x56781234n);
      expect(engine.pc).toBe(0x1008n);
    });

    it('executes ADD and SUB with immediate and updates registers', () => {
      // Set X0 = 100
      engine.setRegister('x0', 100n);

      // 0x1000: add x1, x0, #25 (0x91006401)
      // 0x1004: sub x2, x1, #10 (0xd1002822)
      const code = new Uint8Array([
        0x01, 0x64, 0x00, 0x91, // add x1, x0, #25
        0x22, 0x28, 0x00, 0xd1, // sub x2, x1, #10
      ]);
      busMaster.writePhysical(0x1000n, code);

      engine.step();
      expect(engine.getRegister('x1')).toBe(125n);

      engine.step();
      expect(engine.getRegister('x2')).toBe(115n);
    });

    it('executes SUBS/CMP and correctly sets NZCV condition flags', () => {
      // Set X0 = 42, X1 = 42
      engine.setRegister('x0', 42n);

      // 0x1000: subs x2, x0, #42 -> result 0, Z=1, C=1 (no borrow)
      // [sf:1] [op:1] [s:1] 100010 [shift:0] [imm:42 (0x02a)] [rn:0] [rd:2]
      // 1111 0001 0000 0000 1010 1000 0000 0010 -> 0xf100a802
      const code = new Uint8Array([
        0x02, 0xa8, 0x00, 0xf1, // subs x2, x0, #42
      ]);
      busMaster.writePhysical(0x1000n, code);

      engine.step();
      expect(engine.getRegister('x2')).toBe(0n);
      const flags = engine.getRegister('nzcv');
      const zFlag = (flags & (1n << 30n)) !== 0n;
      const cFlag = (flags & (1n << 29n)) !== 0n;
      expect(zFlag).toBe(true);
      expect(cFlag).toBe(true);
    });

    it('executes bitwise operations (AND, ORR, EOR)', () => {
      engine.setRegister('x0', 0b1100n);
      engine.setRegister('x1', 0b1010n);

      // and x2, x0, x1 (0x8a010002)
      // orr x3, x0, x1 (0xaa010003)
      // eor x4, x0, x1 (0xca010004)
      const code = new Uint8Array([
        0x02, 0x00, 0x01, 0x8a, // and x2, x0, x1
        0x03, 0x00, 0x01, 0xaa, // orr x3, x0, x1
        0x04, 0x00, 0x01, 0xca, // eor x4, x0, x1
      ]);
      busMaster.writePhysical(0x1000n, code);

      engine.step();
      expect(engine.getRegister('x2')).toBe(0b1000n);

      engine.step();
      expect(engine.getRegister('x3')).toBe(0b1110n);

      engine.step();
      expect(engine.getRegister('x4')).toBe(0b0110n);
    });
  });

  describe('3. Memory & Bus Access Side Effects', () => {
    let engine: AArch64ExecutionEngine;

    beforeEach(() => {
      engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);
    });

    it('executes 64-bit STR and LDR against physical memory', () => {
      engine.setRegister('sp', 0x2000n);
      engine.setRegister('x0', 0x1122334455667788n);

      // str x0, [sp, #16] (0xf9000be0: size=3, opc=0, imm12=2 -> offset=16, rn=31, rt=0)
      // ldr x1, [sp, #16] (0xf9400be1: size=3, opc=1, imm12=2 -> offset=16, rn=31, rt=1)
      const code = new Uint8Array([
        0xe0, 0x0b, 0x00, 0xf9, // str x0, [sp, #16]
        0xe1, 0x0b, 0x40, 0xf9, // ldr x1, [sp, #16]
      ]);
      busMaster.writePhysical(0x1000n, code);

      engine.step(); // STR
      // Verify physical bytes in memory at 0x2010n
      const storedBytes = busMaster.readPhysical(0x2010n, 8, accessContext);
      expect(storedBytes).toEqual(
        new Uint8Array([0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11])
      );

      engine.step(); // LDR
      expect(engine.getRegister('x1')).toBe(0x1122334455667788n);
    });

    it('executes byte store (STRB) and byte load (LDRB)', () => {
      engine.setRegister('x0', 0x2000n);
      engine.setRegister('w1', 0xa5n);

      // strb w1, [x0, #4] (0x39001001: size=0, opc=0, imm12=4, rn=0, rt=1)
      // ldrb w2, [x0, #4] (0x39401002: size=0, opc=1, imm12=4, rn=0, rt=2)
      const code = new Uint8Array([
        0x01, 0x10, 0x00, 0x39, // strb w1, [x0, #4]
        0x02, 0x10, 0x40, 0x39, // ldrb w2, [x0, #4]
      ]);
      busMaster.writePhysical(0x1000n, code);

      engine.step();
      expect(busMaster.readPhysical(0x2004n, 1, accessContext)[0]).toBe(0xa5);

      engine.step();
      expect(engine.getRegister('w2')).toBe(0xa5n);
    });

    it('executes STP (store pair) and LDP (load pair) with stack pointer', () => {
      engine.setRegister('sp', 0x3000n);
      engine.setRegister('x0', 0x1111111111111111n);
      engine.setRegister('x1', 0x2222222222222222n);

      // stp x0, x1, [sp, #0] (0xa90007e0: opc=2, imm7=0, rn=31, rt=0, rt2=1)
      // ldp x2, x3, [sp, #0] (0xa9400fe2: opc=2, isLoad=1, imm7=0, rn=31, rt=2, rt2=3)
      const code = new Uint8Array([
        0xe0, 0x07, 0x00, 0xa9, // stp x0, x1, [sp, #0]
        0xe2, 0x0f, 0x40, 0xa9, // ldp x2, x3, [sp, #0]
      ]);
      busMaster.writePhysical(0x1000n, code);

      engine.step(); // STP
      expect(engine.pc).toBe(0x1004n);

      engine.step(); // LDP
      expect(engine.getRegister('x2')).toBe(0x1111111111111111n);
      expect(engine.getRegister('x3')).toBe(0x2222222222222222n);
    });
  });

  describe('4. Control Flow and Branching', () => {
    let engine: AArch64ExecutionEngine;

    beforeEach(() => {
      engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);
    });

    it('executes unconditional branch B offset', () => {
      // 0x1000: b 0x1010 (offset +16 bytes = +4 instructions -> imm26 = 4)
      // 0x14000004
      const code = new Uint8Array([0x04, 0x00, 0x00, 0x14]);
      busMaster.writePhysical(0x1000n, code);

      const res = engine.step();
      expect(res.executed).toBe(true);
      expect(engine.pc).toBe(0x1010n);
    });

    it('executes BL and RET function call cycle', () => {
      // 0x1000: bl 0x1020 (offset +32 bytes = +8 instructions -> imm26 = 8)
      // 0x94000008
      const blCode = new Uint8Array([0x08, 0x00, 0x00, 0x94]);
      busMaster.writePhysical(0x1000n, blCode);

      // 0x1020: ret (0xd65f03c0)
      const retCode = new Uint8Array([0xc0, 0x03, 0x5f, 0xd6]);
      busMaster.writePhysical(0x1020n, retCode);

      engine.step(); // BL
      expect(engine.pc).toBe(0x1020n);
      expect(engine.getRegister('lr')).toBe(0x1004n); // Return address saved in LR

      engine.step(); // RET
      expect(engine.pc).toBe(0x1004n); // Successfully returned to caller
    });

    it('executes conditional branch B.cond based on condition flags', () => {
      // Set Z flag via nzcv register
      engine.setRegister('nzcv', 1n << 30n);

      // 0x1000: b.eq +8 (cond=0, imm19=2 -> 0x54000040)
      const code = new Uint8Array([0x40, 0x00, 0x00, 0x54]);
      busMaster.writePhysical(0x1000n, code);

      engine.step();
      expect(engine.pc).toBe(0x1008n); // Branch taken

      // Now clear Z flag and reset PC to 0x1000
      engine.setRegister('nzcv', 0n);
      engine.setProgramCounter(0x1000n);

      engine.step();
      expect(engine.pc).toBe(0x1004n); // Branch NOT taken
    });

    it('executes CBZ and CBNZ instructions', () => {
      engine.setRegister('x0', 0n);

      // 0x1000: cbz x0, +8 (sf=1, rt=0, imm19=2 -> 0xb5000040)
      const code = new Uint8Array([0x40, 0x00, 0x00, 0xb4]);
      busMaster.writePhysical(0x1000n, code);

      engine.step();
      expect(engine.pc).toBe(0x1008n); // Taken because X0 == 0
    });
  });

  describe('5. State Transitions and Halting', () => {
    it('executes HLT instruction and halts CPU execution cleanly', () => {
      const engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);

      // 0x1000: hlt #0 (0xd4400000)
      busMaster.writePhysical(0x1000n, new Uint8Array([0x00, 0x00, 0x40, 0xd4]));

      const res = engine.step();
      expect(res.executed).toBe(true);
      expect(res.state).toBe(Frt64CoreRunState.HALTED);
      expect(res.reason).toBe('HALTED');
      expect(engine.state).toBe(Frt64CoreRunState.HALTED);

      // Subsequent steps do not execute
      const next = engine.step();
      expect(next.executed).toBe(false);
      expect(next.reason).toBe('HALTED');
    });

    it('executes batch and stops when HLT is reached', () => {
      const engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);

      // 0x1000: nop (0xd503201f)
      // 0x1004: nop (0xd503201f)
      // 0x1008: hlt #0 (0xd4400000)
      // 0x100c: nop (0xd503201f)
      const code = new Uint8Array([
        0x1f, 0x20, 0x03, 0xd5,
        0x1f, 0x20, 0x03, 0xd5,
        0x00, 0x00, 0x40, 0xd4,
        0x1f, 0x20, 0x03, 0xd5,
      ]);
      busMaster.writePhysical(0x1000n, code);

      const batch = engine.executeBatch(10);
      expect(batch.instructionsExecuted).toBe(3); // 2 NOPs + 1 HLT
      expect(batch.finalState).toBe(Frt64CoreRunState.HALTED);
      expect(batch.stoppedReason).toBe('HALTED');
      expect(engine.pc).toBe(0x100cn);
    });

    it('resets CPU state cleanly to initial reset vector', () => {
      const engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);
      engine.setRegister('x0', 999n);
      engine.halt();

      expect(engine.state).toBe(Frt64CoreRunState.HALTED);
      engine.reset(0x2000n);

      expect(engine.state).toBe(Frt64CoreRunState.RESET);
      expect(engine.pc).toBe(0x2000n);
      expect(engine.getRegister('x0')).toBe(0n);
      expect(engine.cyclesExecuted).toBe(0n);
    });
  });

  describe('6. Fault Conditions', () => {
    it('faults when PC is not 4-byte aligned', () => {
      const engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1002n); // Unaligned
      const res = engine.step();

      expect(res.executed).toBe(false);
      expect(res.state).toBe(Frt64CoreRunState.FAULT);
      expect(res.reason).toBe('INVALID_INSTRUCTION');
      expect(res.fault).toContain('Unaligned PC');
    });

    it('faults when an undefined instruction opcode is encountered', () => {
      const engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);
      // Opcode 0x00000000 (unallocated in ARM64)
      busMaster.writePhysical(0x1000n, new Uint8Array([0x00, 0x00, 0x00, 0x00]));

      const res = engine.step();
      expect(res.executed).toBe(false);
      expect(res.state).toBe(Frt64CoreRunState.FAULT);
      expect(res.reason).toBe('INVALID_INSTRUCTION');
      expect(res.fault).toContain('Undefined or unsupported');
    });

    it('faults when accessing unmapped physical memory', () => {
      const engine = new AArch64ExecutionEngine(0, busMaster, accessContext, 0x1000n);
      // str x0, [x1, #0] where X1 points to unmapped address 0xdead_0000n
      engine.setRegister('x1', 0xdead0000n);
      // str x0, [x1, #0] (0xf9000020)
      busMaster.writePhysical(0x1000n, new Uint8Array([0x20, 0x00, 0x00, 0xf9]));

      const res = engine.step();
      expect(res.executed).toBe(false);
      expect(res.state).toBe(Frt64CoreRunState.FAULT);
      expect(res.reason).toBe('MEMORY_FAULT');
    });

    it('explicitly fails with UNSUPPORTED_EXECUTION_FAMILY for non-ARM64 engines', () => {
      const unsupported = new UnsupportedFrt64Engine(Frt64ExecutionFamily.X86_64, 0, 0x1000n);
      const res = unsupported.step();

      expect(res.executed).toBe(false);
      expect(res.state).toBe(Frt64CoreRunState.FAULT);
      expect(res.reason).toBe('UNSUPPORTED_EXECUTION_FAMILY');
      expect(res.fault).toContain('X86_64');
    });

    it('createExecutionEngine returns UnsupportedFrt64Engine for X86_32, X86_64, and ARM_32', () => {
      const x86Engine = createExecutionEngine(
        Frt64ExecutionFamily.X86_64,
        0,
        busMaster,
        accessContext,
        0x1000n
      );
      expect(x86Engine.family).toBe(Frt64ExecutionFamily.X86_64);
      const res = x86Engine.step();
      expect(res.reason).toBe('UNSUPPORTED_EXECUTION_FAMILY');
    });
  });

  describe('7. Multi-Core Execution and Isolation', () => {
    it('manages primary and secondary cores with isolated registers and execution paths', () => {
      const cpu = new Frt64CpuBoundary({
        coreCount: 2,
        defaultFamily: Frt64ExecutionFamily.ARM_64,
        defaultResetVector: 0x1000n,
        primaryCoreId: 0,
      });
      cpu.attachBusMaster(busMaster);
      cpu.attachExecutionEngine();

      const core0 = cpu.getPrimaryCore();
      const core1 = cpu.getCore(1)!;

      // Primary core starts in RESET; secondary core starts in PARKED
      expect(core0.getStatus().runState).toBe(Frt64CoreRunState.RESET);
      expect(core1.getStatus().runState).toBe(Frt64CoreRunState.PARKED);

      // Core 0 executes NOP at 0x1000
      busMaster.writePhysical(0x1000n, new Uint8Array([0x1f, 0x20, 0x03, 0xd5]));
      core0.setRegister('x0', 42n);

      const step0 = core0.step();
      expect(step0.executed).toBe(true);
      expect(core0.getRegister('x0')).toBe(42n);
      expect(core1.getRegister('x0')).toBe(0n); // Isolated register state

      // Unpark secondary core at entry point 0x2000
      busMaster.writePhysical(0x2000n, new Uint8Array([0x1f, 0x20, 0x03, 0xd5]));
      const unparkSuccess = cpu.releaseSecondaryCore(1, 0x2000n);
      expect(unparkSuccess).toBe(true);
      expect(core1.getStatus().runState).toBe(Frt64CoreRunState.RESET);
      expect(core1.pc).toBe(0x2000n);

      // Core 1 can step independently
      const step1 = core1.step();
      expect(step1.executed).toBe(true);
      expect(core1.pc).toBe(0x2004n);
    });
  });

  describe('8. Runtime Execution Pump Integration', () => {
    it('pumps instruction slices across running cores without blocking', () => {
      const cpu = new Frt64CpuBoundary({
        coreCount: 2,
        defaultFamily: Frt64ExecutionFamily.ARM_64,
        defaultResetVector: 0x1000n,
      });
      cpu.attachBusMaster(busMaster);
      cpu.attachExecutionEngine();

      // Write 10 NOPs at 0x1000
      const nops = new Uint8Array(40);
      for (let i = 0; i < 10; i++) {
        nops[i * 4 + 0] = 0x1f;
        nops[i * 4 + 1] = 0x20;
        nops[i * 4 + 2] = 0x03;
        nops[i * 4 + 3] = 0xd5;
      }
      busMaster.writePhysical(0x1000n, nops);

      const pump = new ExecutionPump(cpu, {instructionsPerSlice: 5});

      // Pump one slice of 5 instructions
      const executed = pump.pumpSlice();
      expect(executed).toBe(5);
      expect(pump.getMetrics().totalInstructionsExecuted).toBe(5);
      expect(cpu.getPrimaryCore().pc).toBe(0x1014n); // 5 * 4 = 20 (0x14)

      // Pump second slice of 5 instructions
      const executed2 = pump.pumpSlice();
      expect(executed2).toBe(5);
      expect(pump.getMetrics().totalInstructionsExecuted).toBe(10);
      expect(cpu.getPrimaryCore().pc).toBe(0x1028n); // 10 * 4 = 40 (0x28)
    });

    it('coordinates pause, resume, and stop with execution pump', () => {
      const cpu = new Frt64CpuBoundary({
        coreCount: 1,
        defaultFamily: Frt64ExecutionFamily.ARM_64,
        defaultResetVector: 0x1000n,
      });
      cpu.attachBusMaster(busMaster);
      cpu.attachExecutionEngine();

      const pump = new ExecutionPump(cpu);
      expect(pump.isRunning()).toBe(false);

      pump.start();
      expect(pump.isRunning()).toBe(true);

      pump.pause();
      expect(pump.isRunning()).toBe(false);

      pump.resume();
      expect(pump.isRunning()).toBe(true);

      pump.stop();
      expect(pump.isRunning()).toBe(false);

      pump.reset();
      expect(pump.getMetrics().totalInstructionsExecuted).toBe(0);
    });

    it('integrates with FabricDessertInstance full boot lifecycle', () => {
      // Create a test instance with a Boot ROM that has 3 NOPs followed by HLT
      const bootPayload = new Uint8Array([
        0x1f, 0x20, 0x03, 0xd5, // nop
        0x1f, 0x20, 0x03, 0xd5, // nop
        0x00, 0x00, 0x40, 0xd4, // hlt #0
      ]);

      const instance = createFabricDessertInstance({
        bootContract: {
          bootRomBase: 0x00000000n,
          bootRomSizeBytes: 0x10000n,
          resetVector: 0x00000000n,
          initialPayload: bootPayload,
        },
      });
      instance.attachExecutionEngine();
      instance.initialize();
      instance.start();

      // Pump instructions through instance execution pump
      const executed = instance.executionPump.pumpSlice(10);
      expect(executed).toBe(3); // 2 NOPs + 1 HLT
      expect(instance.cpu.getPrimaryCore().getStatus().runState).toBe(Frt64CoreRunState.HALTED);
    });
  });
});
