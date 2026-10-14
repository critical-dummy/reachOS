import {Address64, formatAddress} from '../../types';
import {CpuAccessContext} from '../../memory/access-context';
import {IFrt64BusMaster} from './boundary';
import {
  BoundedBatchResult,
  EngineExecutionResult,
  IFrt64ExecutionEngine,
} from './engine';
import {Frt64CoreRunState, Frt64ExecutionFamily} from './types';

export interface AArch64Flags {
  n: boolean; // Negative
  z: boolean; // Zero
  c: boolean; // Carry
  v: boolean; // Overflow
}

export interface AArch64RegistersSnapshot {
  x: readonly bigint[];
  sp: bigint;
  pc: bigint;
  flags: AArch64Flags;
  cyclesExecuted: bigint;
}

/**
 * AArch64 (ARM 64-bit) Instruction Execution Engine for Fabric Dessert FRT64.
 *
 * Implements genuine A64 instruction decoding, general-purpose register state (X0-X30, SP),
 * PSTATE.NZCV condition flags, instruction fetch, and load/store memory operations
 * via IFrt64BusMaster into Fabric Dessert physical address space and MMIO.
 *
 * Instruction encodings conform strictly to ARM Architecture Reference Manual (ARM DDI 0487).
 */
export class AArch64ExecutionEngine implements IFrt64ExecutionEngine {
  readonly family = Frt64ExecutionFamily.ARM_64;
  readonly coreId: number;

  private readonly x = new BigUint64Array(31);
  private sp = 0n;
  private pc = 0n;
  private resetVector = 0n;
  private flags: AArch64Flags = {n: false, z: false, c: false, v: false};
  private runState: Frt64CoreRunState = Frt64CoreRunState.RESET;
  private cyclesExecuted = 0n;
  private busMaster: IFrt64BusMaster;
  private readonly accessContext: CpuAccessContext;

  constructor(
    coreId: number,
    busMaster: IFrt64BusMaster,
    accessContext: CpuAccessContext,
    initialResetVector: Address64 = 0n
  ) {
    this.coreId = coreId;
    this.busMaster = busMaster;
    this.accessContext = accessContext;
    this.resetVector = initialResetVector;
    this.pc = initialResetVector;
  }

  setBusMaster(busMaster: IFrt64BusMaster): void {
    this.busMaster = busMaster;
  }

  get isRunning(): boolean {
    return this.runState === Frt64CoreRunState.RUNNING;
  }

  getProgramCounter(): Address64 {
    return this.pc;
  }

  setProgramCounter(pc: Address64): void {
    this.pc = pc;
  }

  getRegister(nameOrIndex: string | number): bigint {
    if (typeof nameOrIndex === 'number') {
      return this.readReg(nameOrIndex);
    }
    const normalized = nameOrIndex.trim().toUpperCase();
    if (normalized === 'SP') {
      return this.sp;
    }
    if (normalized === 'PC') {
      return this.pc;
    }
    if (normalized === 'XZR' || normalized === 'WZR') {
      return 0n;
    }
    if (normalized.startsWith('X') || normalized.startsWith('W')) {
      const idx = parseInt(normalized.substring(1), 10);
      if (!isNaN(idx) && idx >= 0 && idx <= 30) {
        return normalized.startsWith('W')
          ? BigInt(Number(this.readReg(idx) & 0xffffffffn))
          : this.readReg(idx);
      }
    }
    return 0n;
  }

  setRegister(nameOrIndex: string | number, value: bigint): void {
    if (typeof nameOrIndex === 'number') {
      this.writeReg(nameOrIndex, value);
      return;
    }
    const normalized = nameOrIndex.trim().toUpperCase();
    if (normalized === 'SP') {
      this.sp = BigInt.asUintN(64, value);
      return;
    }
    if (normalized === 'PC') {
      this.pc = BigInt.asUintN(64, value);
      return;
    }
    if (normalized === 'XZR' || normalized === 'WZR') {
      return; // writes discarded
    }
    if (normalized.startsWith('X')) {
      const idx = parseInt(normalized.substring(1), 10);
      if (!isNaN(idx) && idx >= 0 && idx <= 30) {
        this.writeReg(idx, value);
      }
    } else if (normalized.startsWith('W')) {
      const idx = parseInt(normalized.substring(1), 10);
      if (!isNaN(idx) && idx >= 0 && idx <= 30) {
        this.writeReg32(idx, Number(BigInt.asUintN(32, value)));
      }
    }
  }

  getStateSnapshot(): Record<string, unknown> {
    const xRegs: bigint[] = [];
    for (let i = 0; i < 31; i++) {
      xRegs.push(this.x[i]);
    }
    const snapshot: AArch64RegistersSnapshot = {
      x: xRegs,
      sp: this.sp,
      pc: this.pc,
      flags: {...this.flags},
      cyclesExecuted: this.cyclesExecuted,
    };
    return {
      family: this.family,
      coreId: this.coreId,
      runState: this.runState,
      ...snapshot,
    };
  }

  reset(entryVector?: Address64): void {
    if (entryVector !== undefined) {
      this.resetVector = entryVector;
    }
    this.pc = this.resetVector;
    this.sp = 0n;
    this.x.fill(0n);
    this.flags = {n: false, z: false, c: false, v: false};
    this.cyclesExecuted = 0n;
    this.runState = Frt64CoreRunState.RESET;
  }

  halt(): void {
    this.runState = Frt64CoreRunState.HALTED;
  }

  pause(): void {
    if (this.runState === Frt64CoreRunState.RUNNING) {
      this.runState = Frt64CoreRunState.PAUSED;
    }
  }

  resume(): void {
    if (
      this.runState === Frt64CoreRunState.RESET ||
      this.runState === Frt64CoreRunState.PAUSED ||
      this.runState === Frt64CoreRunState.HALTED
    ) {
      this.runState = Frt64CoreRunState.RUNNING;
    }
  }

  dispose(): void {
    this.halt();
    this.x.fill(0n);
  }

  // --- Internal Register Access Helpers ---

  private readReg(r: number): bigint {
    if (r === 31) return 0n; // XZR
    if (r < 0 || r > 30) return 0n;
    return this.x[r];
  }

  private writeReg(r: number, val: bigint): void {
    if (r === 31) return; // writes to XZR discarded
    if (r < 0 || r > 30) return;
    this.x[r] = BigInt.asUintN(64, val);
  }

  private readReg32(r: number): number {
    return Number(this.readReg(r) & 0xffffffffn);
  }

  private writeReg32(r: number, val: number | bigint): void {
    if (r === 31) return; // WZR
    if (r < 0 || r > 30) return;
    // ARM64 rule: 32-bit register writes zero out the upper 32 bits of X
    this.x[r] = BigInt.asUintN(32, BigInt(val));
  }

  // --- Arithmetic & Logic Flag Calculation ---

  private addWithCarry(
    op1: bigint,
    op2: bigint,
    carryIn: bigint,
    width: 32 | 64
  ): {result: bigint; n: boolean; z: boolean; c: boolean; v: boolean} {
    const unsignedSum = op1 + op2 + carryIn;
    const result = BigInt.asUintN(width, unsignedSum);
    const signBit = width === 64 ? 63n : 31n;
    const n = ((result >> signBit) & 1n) === 1n;
    const z = result === 0n;
    const c = (unsignedSum >> BigInt(width)) > 0n;

    const sOp1 = BigInt.asIntN(width, op1);
    const sOp2 = BigInt.asIntN(width, op2);
    const sRes = BigInt.asIntN(width, result);
    const v =
      (sOp1 > 0n && sOp2 > 0n && sRes <= 0n) ||
      (sOp1 < 0n && sOp2 < 0n && sRes >= 0n);

    return {result, n, z, c, v};
  }

  private subWithCarry(
    op1: bigint,
    op2: bigint,
    width: 32 | 64
  ): {result: bigint; n: boolean; z: boolean; c: boolean; v: boolean} {
    const mask = width === 64 ? 0xffffffffffffffffn : 0xffffffffn;
    const invertedOp2 = (~op2) & mask;
    // Subtraction op1 - op2 is addition op1 + ~op2 + 1
    const unsignedSum = op1 + invertedOp2 + 1n;
    const result = BigInt.asUintN(width, unsignedSum);
    const signBit = width === 64 ? 63n : 31n;
    const n = ((result >> signBit) & 1n) === 1n;
    const z = result === 0n;
    // In ARM, carry out is 1 if unsigned borrow did NOT occur (op1 >= op2)
    const c = op1 >= op2;

    const sOp1 = BigInt.asIntN(width, op1);
    const sOp2 = BigInt.asIntN(width, op2);
    const sRes = BigInt.asIntN(width, result);
    const v =
      (sOp1 >= 0n && sOp2 < 0n && sRes < 0n) ||
      (sOp1 < 0n && sOp2 >= 0n && sRes >= 0n);

    return {result, n, z, c, v};
  }

  private updateLogicFlags(result: bigint, width: 32 | 64): void {
    const signBit = width === 64 ? 63n : 31n;
    this.flags.n = ((result >> signBit) & 1n) === 1n;
    this.flags.z = result === 0n;
    this.flags.c = false;
    this.flags.v = false;
  }

  // --- Sign Extension Helpers ---

  private signExtend(val: number, bits: number): bigint {
    const signMask = 1 << (bits - 1);
    if ((val & signMask) !== 0) {
      return BigInt(val - (1 << bits));
    }
    return BigInt(val);
  }

  // --- Condition Code Evaluator (ARM A64 standard) ---

  private evaluateCondition(cond: number): boolean {
    switch (cond) {
      case 0x0: return this.flags.z; // EQ
      case 0x1: return !this.flags.z; // NE
      case 0x2: return this.flags.c; // CS / HS
      case 0x3: return !this.flags.c; // CC / LO
      case 0x4: return this.flags.n; // MI
      case 0x5: return !this.flags.n; // PL
      case 0x6: return this.flags.v; // VS
      case 0x7: return !this.flags.v; // VC
      case 0x8: return this.flags.c && !this.flags.z; // HI
      case 0x9: return !this.flags.c || this.flags.z; // LS
      case 0xa: return this.flags.n === this.flags.v; // GE
      case 0xb: return this.flags.n !== this.flags.v; // LT
      case 0xc: return !this.flags.z && (this.flags.n === this.flags.v); // GT
      case 0xd: return this.flags.z || (this.flags.n !== this.flags.v); // LE
      case 0xe: return true; // AL (Always)
      case 0xf: return true; // NV (Always in AArch64)
      default: return true;
    }
  }

  // --- Core Single-Instruction Execution ---

  step(): EngineExecutionResult {
    if (this.runState === Frt64CoreRunState.PARKED) {
      return {executed: false, state: this.runState, reason: 'PARKED', pc: this.pc, cyclesExecuted: this.cyclesExecuted};
    }
    if (this.runState === Frt64CoreRunState.HALTED) {
      return {executed: false, state: this.runState, reason: 'HALTED', pc: this.pc, cyclesExecuted: this.cyclesExecuted};
    }
    if (this.runState === Frt64CoreRunState.FAULT) {
      return {executed: false, state: this.runState, reason: 'FAULT', pc: this.pc, cyclesExecuted: this.cyclesExecuted};
    }

    const currentPc = this.pc;

    // 1. Fetch 32-bit A64 instruction word from Physical Address Space
    let insnBytes: Uint8Array;
    try {
      insnBytes = this.busMaster.fetchInstructionPhysical(currentPc, 4, this.accessContext);
    } catch (err: unknown) {
      this.runState = Frt64CoreRunState.FAULT;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        executed: false,
        state: Frt64CoreRunState.FAULT,
        reason: 'MEMORY_FAULT',
        pc: currentPc,
        cyclesExecuted: this.cyclesExecuted,
        fault: `Instruction fetch fault at ${formatAddress(currentPc)}: ${msg}`,
      };
    }

    if (insnBytes.length < 4) {
      this.runState = Frt64CoreRunState.FAULT;
      return {
        executed: false,
        state: Frt64CoreRunState.FAULT,
        reason: 'MEMORY_FAULT',
        pc: currentPc,
        cyclesExecuted: this.cyclesExecuted,
        fault: `Short instruction fetch at ${formatAddress(currentPc)}: expected 4 bytes, received ${insnBytes.length}`,
      };
    }

    const opcode =
      (insnBytes[0] |
        (insnBytes[1] << 8) |
        (insnBytes[2] << 16) |
        (insnBytes[3] << 24)) >>> 0;

    // 2. Decode and Execute A64 Instruction
    return this.executeA64Opcode(opcode, currentPc);
  }

  executeBatch(maxInstructions: number): BoundedBatchResult {
    let executedCount = 0;
    const startCycles = this.cyclesExecuted;

    while (executedCount < maxInstructions) {
      if (
        this.runState === Frt64CoreRunState.HALTED ||
        this.runState === Frt64CoreRunState.FAULT ||
        this.runState === Frt64CoreRunState.PARKED ||
        this.runState === Frt64CoreRunState.PAUSED
      ) {
        return {
          instructionsExecuted: executedCount,
          cyclesExecuted: this.cyclesExecuted - startCycles,
          finalState: this.runState,
          lastPc: this.pc,
        };
      }

      const res = this.step();
      if (!res.executed) {
        return {
          instructionsExecuted: executedCount,
          cyclesExecuted: this.cyclesExecuted - startCycles,
          finalState: this.runState,
          lastPc: this.pc,
          stoppedReason: res.reason,
          fault: res.fault,
        };
      }
      executedCount++;
    }

    return {
      instructionsExecuted: executedCount,
      cyclesExecuted: this.cyclesExecuted - startCycles,
      finalState: this.runState,
      lastPc: this.pc,
    };
  }

  private executeA64Opcode(opcode: number, currentPc: Address64): EngineExecutionResult {
    // A. System & Control Instructions
    // HLT
    if ((opcode & 0xffe0001f) === 0xd4400000) {
      this.runState = Frt64CoreRunState.HALTED;
      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {
        executed: true,
        state: Frt64CoreRunState.HALTED,
        reason: 'HALTED',
        pc: this.pc,
        cyclesExecuted: this.cyclesExecuted,
        opcode,
        disassembly: `HLT #${(opcode >> 5) & 0xffff}`,
      };
    }

    // BRK
    if ((opcode & 0xffe0001f) === 0xd4200000) {
      this.runState = Frt64CoreRunState.FAULT;
      this.cyclesExecuted++;
      return {
        executed: false,
        state: Frt64CoreRunState.FAULT,
        reason: 'FAULT',
        pc: currentPc,
        cyclesExecuted: this.cyclesExecuted,
        opcode,
        fault: `Breakpoint (BRK #${(opcode >> 5) & 0xffff}) at ${formatAddress(currentPc)}`,
      };
    }

    // NOP / WFI / WFE
    if (opcode === 0xd503201f) {
      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode, disassembly: 'NOP'};
    }
    if (opcode === 0xd503207f) {
      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode, disassembly: 'WFI'};
    }
    if (opcode === 0xd503205f) {
      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode, disassembly: 'WFE'};
    }

    // B. Move Wide: MOVZ / MOVN / MOVK
    if (((opcode >> 23) & 0x3f) === 0x25) {
      const sf = (opcode >> 31) & 1;
      const opc = (opcode >> 29) & 3;
      const hw = (opcode >> 21) & 3;
      const imm16 = (opcode >> 5) & 0xffff;
      const rd = opcode & 0x1f;

      if (sf === 0 && hw >= 2) {
        return this.faultInvalidInsn(opcode, currentPc, 'Invalid shift hw for 32-bit move wide');
      }

      const shift = BigInt(hw * 16);
      let val = 0n;

      if (sf === 1) {
        // 64-bit
        if (opc === 2) {
          // MOVZ
          val = BigInt.asUintN(64, BigInt(imm16) << shift);
          this.writeReg(rd, val);
        } else if (opc === 0) {
          // MOVN
          val = BigInt.asUintN(64, ~(BigInt(imm16) << shift));
          this.writeReg(rd, val);
        } else if (opc === 3) {
          // MOVK
          const mask = ~(0xffffn << shift) & 0xffffffffffffffffn;
          val = (this.readReg(rd) & mask) | (BigInt(imm16) << shift);
          this.writeReg(rd, val);
        } else {
          return this.faultInvalidInsn(opcode, currentPc, 'Reserved move wide opc');
        }
      } else {
        // 32-bit
        if (opc === 2) {
          // MOVZ
          val = BigInt.asUintN(32, BigInt(imm16) << shift);
          this.writeReg32(rd, Number(val));
        } else if (opc === 0) {
          // MOVN
          val = BigInt.asUintN(32, ~(BigInt(imm16) << shift));
          this.writeReg32(rd, Number(val));
        } else if (opc === 3) {
          // MOVK
          const mask = ~(0xffffn << shift) & 0xffffffffn;
          val = (BigInt(this.readReg32(rd)) & mask) | (BigInt(imm16) << shift);
          this.writeReg32(rd, Number(val));
        } else {
          return this.faultInvalidInsn(opcode, currentPc, 'Reserved move wide opc');
        }
      }

      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // C. Add/Subtract (immediate): ADD / ADDS / SUB / SUBS / CMP
    if (((opcode >> 24) & 0x1f) === 0x11) {
      const sf = (opcode >> 31) & 1;
      const op = (opcode >> 30) & 1;
      const s = (opcode >> 29) & 1;
      const shift = (opcode >> 22) & 3;
      const imm12 = (opcode >> 10) & 0xfff;
      const rn = (opcode >> 5) & 0x1f;
      const rd = opcode & 0x1f;

      if (shift > 1) {
        return this.faultInvalidInsn(opcode, currentPc, 'Reserved shift in add/sub immediate');
      }

      const imm = BigInt(imm12) << BigInt(shift === 1 ? 12 : 0);

      if (sf === 1) {
        // 64-bit
        const op1 = rn === 31 ? this.sp : this.readReg(rn);
        const res =
          op === 0
            ? this.addWithCarry(op1, imm, 0n, 64)
            : this.subWithCarry(op1, imm, 64);

        if (s === 1) {
          this.flags = {n: res.n, z: res.z, c: res.c, v: res.v};
        }
        if (rd === 31 && s === 0) {
          this.sp = res.result;
        } else if (rd !== 31) {
          this.writeReg(rd, res.result);
        }
      } else {
        // 32-bit
        const op1 = rn === 31 ? BigInt(Number(this.sp & 0xffffffffn)) : BigInt(this.readReg32(rn));
        const res =
          op === 0
            ? this.addWithCarry(op1, imm, 0n, 32)
            : this.subWithCarry(op1, imm, 32);

        if (s === 1) {
          this.flags = {n: res.n, z: res.z, c: res.c, v: res.v};
        }
        if (rd === 31 && s === 0) {
          this.sp = BigInt.asUintN(64, res.result);
        } else if (rd !== 31) {
          this.writeReg32(rd, Number(res.result));
        }
      }

      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // D. PC-relative Addressing: ADR / ADRP
    if (((opcode >> 24) & 0x1f) === 0x10) {
      const isAdrp = ((opcode >> 31) & 1) === 1;
      const immlo = (opcode >> 29) & 3;
      const immhi = (opcode >> 5) & 0x7ffff;
      const imm21 = (immhi << 2) | immlo;
      const signedImm = this.signExtend(imm21, 21);
      const rd = opcode & 0x1f;

      if (isAdrp) {
        // ADRP: forms 4KB page aligned address
        const basePage = currentPc & ~0xfffn;
        this.writeReg(rd, basePage + (signedImm << 12n));
      } else {
        // ADR: forms PC-relative address
        this.writeReg(rd, currentPc + signedImm);
      }

      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // E. Add/Subtract (shifted register): ADD / ADDS / SUB / SUBS / CMP
    if (((opcode >> 24) & 0x1f) === 0x0b && ((opcode >> 21) & 1) === 0) {
      const sf = (opcode >> 31) & 1;
      const op = (opcode >> 30) & 1;
      const s = (opcode >> 29) & 1;
      const shift = (opcode >> 22) & 3;
      const rm = (opcode >> 16) & 0x1f;
      const imm6 = (opcode >> 10) & 0x3f;
      const rn = (opcode >> 5) & 0x1f;
      const rd = opcode & 0x1f;

      if (sf === 0 && imm6 >= 32) {
        return this.faultInvalidInsn(opcode, currentPc, 'Invalid shift amount for 32-bit register add/sub');
      }

      const width = sf === 1 ? 64 : 32;
      let rawRm = sf === 1 ? this.readReg(rm) : BigInt(this.readReg32(rm));

      // Apply shift (0=LSL, 1=LSR, 2=ASR)
      if (shift === 0) {
        rawRm = BigInt.asUintN(width, rawRm << BigInt(imm6));
      } else if (shift === 1) {
        rawRm = BigInt.asUintN(width, rawRm >> BigInt(imm6));
      } else if (shift === 2) {
        rawRm = BigInt.asUintN(width, BigInt(BigInt.asIntN(width, rawRm) >> BigInt(imm6)));
      } else {
        return this.faultInvalidInsn(opcode, currentPc, 'Reserved shift type');
      }

      const op1 = sf === 1 ? this.readReg(rn) : BigInt(this.readReg32(rn));
      const res =
        op === 0
          ? this.addWithCarry(op1, rawRm, 0n, width)
          : this.subWithCarry(op1, rawRm, width);

      if (s === 1) {
        this.flags = {n: res.n, z: res.z, c: res.c, v: res.v};
      }
      if (rd !== 31) {
        if (sf === 1) {
          this.writeReg(rd, res.result);
        } else {
          this.writeReg32(rd, Number(res.result));
        }
      }

      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // F. Logical (shifted register): AND / BIC / ORR / ORN / EOR / EON / ANDS / BICS
    if (((opcode >> 24) & 0x1f) === 0x0a) {
      const sf = (opcode >> 31) & 1;
      const opc = (opcode >> 29) & 3;
      const shift = (opcode >> 22) & 3;
      const n = (opcode >> 21) & 1;
      const rm = (opcode >> 16) & 0x1f;
      const imm6 = (opcode >> 10) & 0x3f;
      const rn = (opcode >> 5) & 0x1f;
      const rd = opcode & 0x1f;

      const width = sf === 1 ? 64 : 32;
      let rawRm = sf === 1 ? this.readReg(rm) : BigInt(this.readReg32(rm));

      if (shift === 0) {
        rawRm = BigInt.asUintN(width, rawRm << BigInt(imm6));
      } else if (shift === 1) {
        rawRm = BigInt.asUintN(width, rawRm >> BigInt(imm6));
      } else if (shift === 2) {
        rawRm = BigInt.asUintN(width, BigInt(BigInt.asIntN(width, rawRm) >> BigInt(imm6)));
      }

      if (n === 1) {
        rawRm = ~rawRm;
      }

      const op1 = sf === 1 ? this.readReg(rn) : BigInt(this.readReg32(rn));
      let res = 0n;

      if (opc === 0) {
        // AND / BIC
        res = BigInt.asUintN(width, op1 & rawRm);
      } else if (opc === 1) {
        // ORR / ORN (Includes MOV Xd, Xm when Rn=31, shift=0, imm=0)
        res = BigInt.asUintN(width, op1 | rawRm);
      } else if (opc === 2) {
        // EOR / EON
        res = BigInt.asUintN(width, op1 ^ rawRm);
      } else if (opc === 3) {
        // ANDS / BICS (TST)
        res = BigInt.asUintN(width, op1 & rawRm);
        this.updateLogicFlags(res, width);
      }

      if (opc !== 3 || rd !== 31) {
        if (sf === 1) {
          this.writeReg(rd, res);
        } else {
          this.writeReg32(rd, Number(res));
        }
      }

      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // G. Unconditional Branch (immediate): B / BL
    if (((opcode >> 26) & 0x1f) === 0x05) {
      const isBl = ((opcode >> 31) & 1) === 1;
      const imm26 = opcode & 0x3ffffff;
      const offset = this.signExtend(imm26, 26) << 2n;

      if (isBl) {
        this.writeReg(30, currentPc + 4n); // X30 = return address
      }
      this.pc = currentPc + offset;
      this.cyclesExecuted++;
      return {
        executed: true,
        state: this.runState,
        reason: 'OK',
        pc: this.pc,
        cyclesExecuted: this.cyclesExecuted,
        opcode,
        disassembly: `${isBl ? 'BL' : 'B'} ${formatAddress(this.pc)}`,
      };
    }

    // H. Conditional Branch: B.cond
    if (((opcode >> 24) & 0xff) === 0x54 && (opcode & 0x10) === 0) {
      const imm19 = (opcode >> 5) & 0x7ffff;
      const cond = opcode & 0xf;
      const offset = this.signExtend(imm19, 19) << 2n;

      if (this.evaluateCondition(cond)) {
        this.pc = currentPc + offset;
      } else {
        this.pc = currentPc + 4n;
      }
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // I. Unconditional Branch (register): BR / BLR / RET
    if (((opcode >> 25) & 0x7f) === 0x6b && ((opcode >> 16) & 0x1f) === 0x1f && ((opcode >> 10) & 0x3f) === 0) {
      const op = (opcode >> 21) & 3;
      const rn = (opcode >> 5) & 0x1f;

      if (op === 0) {
        // BR
        this.pc = this.readReg(rn);
      } else if (op === 1) {
        // BLR
        this.writeReg(30, currentPc + 4n);
        this.pc = this.readReg(rn);
      } else if (op === 2) {
        // RET (defaults to X30 if Rn == 30)
        this.pc = this.readReg(rn);
      } else {
        return this.faultInvalidInsn(opcode, currentPc, 'Reserved branch register op');
      }

      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // J. Compare and Branch: CBZ / CBNZ
    if (((opcode >> 25) & 0x3f) === 0x1a) {
      const sf = (opcode >> 31) & 1;
      const isCbnz = ((opcode >> 24) & 1) === 1;
      const imm19 = (opcode >> 5) & 0x7ffff;
      const rt = opcode & 0x1f;
      const offset = this.signExtend(imm19, 19) << 2n;

      const val = sf === 1 ? this.readReg(rt) : BigInt(this.readReg32(rt));
      const taken = isCbnz ? val !== 0n : val === 0n;

      if (taken) {
        this.pc = currentPc + offset;
      } else {
        this.pc = currentPc + 4n;
      }
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // K. Load / Store (unsigned immediate)
    // Mask: size[31:30] 111 V[26] 01 opc[23:22] imm12[21:10] Rn[9:5] Rt[4:0]
    if (((opcode >> 27) & 0x7) === 0x7 && ((opcode >> 24) & 0x3) === 0x1 && ((opcode >> 26) & 1) === 0) {
      const size = (opcode >> 30) & 3; // 0=byte, 1=half, 2=word, 3=doubleword
      const opc = (opcode >> 22) & 3; // 00=STR, 01=LDR
      const imm12 = (opcode >> 10) & 0xfff;
      const rn = (opcode >> 5) & 0x1f;
      const rt = opcode & 0x1f;

      const byteCount = 1 << size;
      const offset = BigInt(imm12) * BigInt(byteCount);
      const baseAddr = rn === 31 ? this.sp : this.readReg(rn);
      const targetAddr = baseAddr + offset;

      if (opc === 0) {
        // STR (Store)
        const val = this.readReg(rt);
        const data = new Uint8Array(byteCount);
        for (let i = 0; i < byteCount; i++) {
          data[i] = Number((val >> BigInt(i * 8)) & 0xffn);
        }
        try {
          this.busMaster.writePhysical(targetAddr, data, this.accessContext);
        } catch (err: unknown) {
          return this.faultMemory(targetAddr, err, currentPc);
        }
      } else if (opc === 1) {
        // LDR (Load)
        let data: Uint8Array;
        try {
          data = this.busMaster.readPhysical(targetAddr, byteCount, this.accessContext);
        } catch (err: unknown) {
          return this.faultMemory(targetAddr, err, currentPc);
        }

        let loadedVal = 0n;
        for (let i = 0; i < byteCount; i++) {
          loadedVal |= BigInt(data[i]) << BigInt(i * 8);
        }

        if (size === 3) {
          // 64-bit doubleword
          this.writeReg(rt, loadedVal);
        } else {
          // 32-bit, 16-bit, or 8-bit zero-extended into Wt (upper 32-bits zeroed)
          this.writeReg32(rt, Number(loadedVal));
        }
      } else {
        return this.faultInvalidInsn(opcode, currentPc, 'Unsupported load/store unsigned immediate opc');
      }

      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // L. Load / Store Pair: STP / LDP
    if (((opcode >> 27) & 0x7) === 0x5 && ((opcode >> 26) & 1) === 0) {
      const opc = (opcode >> 30) & 3; // 00=32-bit, 10=64-bit
      const isLdp = ((opcode >> 22) & 1) === 1;
      const imm7 = (opcode >> 15) & 0x7f;
      const rt2 = (opcode >> 10) & 0x1f;
      const rn = (opcode >> 5) & 0x1f;
      const rt1 = opcode & 0x1f;

      const scale = opc === 2 ? 8 : 4;
      const byteCount = scale;
      const offset = this.signExtend(imm7, 7) * BigInt(scale);
      const baseAddr = rn === 31 ? this.sp : this.readReg(rn);

      const targetAddr1 = baseAddr + offset;
      const targetAddr2 = targetAddr1 + BigInt(byteCount);

      if (!isLdp) {
        // STP
        const val1 = this.readReg(rt1);
        const val2 = this.readReg(rt2);

        const data1 = new Uint8Array(byteCount);
        const data2 = new Uint8Array(byteCount);
        for (let i = 0; i < byteCount; i++) {
          data1[i] = Number((val1 >> BigInt(i * 8)) & 0xffn);
          data2[i] = Number((val2 >> BigInt(i * 8)) & 0xffn);
        }

        try {
          this.busMaster.writePhysical(targetAddr1, data1, this.accessContext);
          this.busMaster.writePhysical(targetAddr2, data2, this.accessContext);
        } catch (err: unknown) {
          return this.faultMemory(targetAddr1, err, currentPc);
        }
      } else {
        // LDP
        let data1: Uint8Array;
        let data2: Uint8Array;
        try {
          data1 = this.busMaster.readPhysical(targetAddr1, byteCount, this.accessContext);
          data2 = this.busMaster.readPhysical(targetAddr2, byteCount, this.accessContext);
        } catch (err: unknown) {
          return this.faultMemory(targetAddr1, err, currentPc);
        }

        let lVal1 = 0n;
        let lVal2 = 0n;
        for (let i = 0; i < byteCount; i++) {
          lVal1 |= BigInt(data1[i]) << BigInt(i * 8);
          lVal2 |= BigInt(data2[i]) << BigInt(i * 8);
        }

        if (scale === 8) {
          this.writeReg(rt1, lVal1);
          this.writeReg(rt2, lVal2);
        } else {
          this.writeReg32(rt1, Number(lVal1));
          this.writeReg32(rt2, Number(lVal2));
        }
      }

      this.pc = currentPc + 4n;
      this.cyclesExecuted++;
      return {executed: true, state: this.runState, reason: 'OK', pc: this.pc, cyclesExecuted: this.cyclesExecuted, opcode};
    }

    // Default: Opcode not handled in supported subset
    return this.faultInvalidInsn(opcode, currentPc, 'Unimplemented or invalid ARM64 instruction');
  }

  private faultInvalidInsn(opcode: number, currentPc: Address64, reason: string): EngineExecutionResult {
    this.runState = Frt64CoreRunState.FAULT;
    return {
      executed: false,
      state: Frt64CoreRunState.FAULT,
      reason: 'INVALID_INSTRUCTION',
      pc: currentPc,
      cyclesExecuted: this.cyclesExecuted,
      opcode,
      fault: `${reason}: 0x${opcode.toString(16).padStart(8, '0')} at ${formatAddress(currentPc)}`,
    };
  }

  private faultMemory(addr: Address64, err: unknown, currentPc: Address64): EngineExecutionResult {
    this.runState = Frt64CoreRunState.FAULT;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      executed: false,
      state: Frt64CoreRunState.FAULT,
      reason: 'MEMORY_FAULT',
      pc: currentPc,
      cyclesExecuted: this.cyclesExecuted,
      fault: `Physical memory access fault at ${formatAddress(addr)}: ${msg}`,
    };
  }
}
