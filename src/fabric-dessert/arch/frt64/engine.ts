/**
 * FRT64 Execution Engine Implementation.
 * Provides genuine instruction execution backends for FRT64 CPU cores.
 * Default and primary supported architecture: ARM_64 (AArch64).
 */

import {Address64, assertValidAddress64, formatAddress} from '../../types';
import {CpuAccessContext} from '../../memory/access-context';
import {
  ExecutionStepReason,
  ExecutionStepResult,
  Frt64CoreRunState,
  Frt64ExecutionFamily,
} from './types';
import {IFrt64BusMaster} from './boundary';

export interface BoundedBatchResult {
  instructionsExecuted: number;
  cyclesExecuted: bigint;
  finalState: Frt64CoreRunState;
  lastPc: Address64;
  stoppedReason: ExecutionStepReason;
}

export interface IFrt64ExecutionEngine {
  readonly coreId: number;
  readonly family: Frt64ExecutionFamily;
  readonly pc: Address64;
  readonly state: Frt64CoreRunState;
  setProgramCounter(address: Address64): void;
  getRegister(nameOrIndex: string | number): bigint;
  setRegister(nameOrIndex: string | number, value: bigint): void;
  reset(vector: Address64): void;
  halt(): void;
  pause(): void;
  resume(): void;
  getStateSnapshot(): Record<string, unknown>;
  step(): ExecutionStepResult;
  executeBatch(maxInstructions: number): BoundedBatchResult;
  setBusMaster?(bus: IFrt64BusMaster): void;
}

const MASK_64 = 0xffff_ffff_ffff_ffffn;
const MASK_32 = 0xffff_ffffn;
const SIGN_BIT_64 = 63n;
const SIGN_BIT_32 = 31n;

/**
 * Genuine AArch64 (ARM 64-bit) Execution Engine.
 * Executes genuine AArch64 machine instructions fetched over IFrt64BusMaster.
 */
export class AArch64ExecutionEngine implements IFrt64ExecutionEngine {
  readonly family = Frt64ExecutionFamily.ARM_64;
  readonly coreId: number;
  pc: Address64;
  state: Frt64CoreRunState = Frt64CoreRunState.RESET;
  cyclesExecuted = 0n;

  // 31 General-Purpose 64-bit Registers (X0 - X30)
  private readonly x = new BigUint64Array(31);
  // Stack Pointer (SP)
  private sp = 0n;

  // PSTATE Condition Flags (NZCV)
  private n = false; // Negative
  private z = false; // Zero
  private c = false; // Carry
  private v = false; // Overflow

  private busMaster: IFrt64BusMaster;
  private readonly accessContext: CpuAccessContext;

  constructor(
    coreId: number,
    busMaster: IFrt64BusMaster,
    accessContext: CpuAccessContext,
    initialPc: Address64 = 0n
  ) {
    this.coreId = coreId;
    this.busMaster = busMaster;
    this.accessContext = accessContext;
    assertValidAddress64(initialPc, 'AArch64 initialPc');
    this.pc = initialPc;
  }

  setBusMaster(bus: IFrt64BusMaster): void {
    this.busMaster = bus;
  }

  setProgramCounter(address: Address64): void {
    assertValidAddress64(address, 'AArch64 setProgramCounter');
    this.pc = address;
  }

  getX(reg: number): bigint {
    if (reg < 0 || reg > 31) return 0n;
    if (reg === 31) return 0n; // XZR (Zero register) in general register read contexts
    return this.x[reg];
  }

  setX(reg: number, val: bigint, is64 = true): void {
    if (reg < 0 || reg >= 31) return; // reg 31 is XZR/WZR; writes are discarded
    const masked = is64 ? (val & MASK_64) : (val & MASK_32);
    this.x[reg] = masked;
  }

  getSP(): bigint {
    return this.sp & MASK_64;
  }

  setSP(val: bigint): void {
    this.sp = val & MASK_64;
  }

  getRegister(nameOrIndex: string | number): bigint {
    if (typeof nameOrIndex === 'number') {
      if (nameOrIndex >= 0 && nameOrIndex < 31) {
        return this.x[nameOrIndex];
      }
      if (nameOrIndex === 31) {
        return this.getSP();
      }
      return 0n;
    }

    const lower = nameOrIndex.trim().toLowerCase();
    if (lower === 'sp') return this.getSP();
    if (lower === 'pc') return this.pc;
    if (lower === 'lr' || lower === 'x30') return this.x[30];
    if (lower === 'fp' || lower === 'x29') return this.x[29];
    if (lower === 'nzcv' || lower === 'pstate' || lower === 'cpsr') {
      let flags = 0n;
      if (this.n) flags |= (1n << 31n);
      if (this.z) flags |= (1n << 30n);
      if (this.c) flags |= (1n << 29n);
      if (this.v) flags |= (1n << 28n);
      return flags;
    }

    if (lower.startsWith('x')) {
      const idx = parseInt(lower.slice(1), 10);
      if (!isNaN(idx) && idx >= 0 && idx < 31) return this.x[idx];
      if (idx === 31) return this.getSP();
    }
    if (lower.startsWith('w')) {
      const idx = parseInt(lower.slice(1), 10);
      if (!isNaN(idx) && idx >= 0 && idx < 31) return this.x[idx] & MASK_32;
      if (idx === 31) return this.getSP() & MASK_32;
    }

    return 0n;
  }

  setRegister(nameOrIndex: string | number, value: bigint): void {
    if (typeof nameOrIndex === 'number') {
      if (nameOrIndex >= 0 && nameOrIndex < 31) {
        this.x[nameOrIndex] = value & MASK_64;
      } else if (nameOrIndex === 31) {
        this.setSP(value);
      }
      return;
    }

    const lower = nameOrIndex.trim().toLowerCase();
    if (lower === 'sp') {
      this.setSP(value);
      return;
    }
    if (lower === 'pc') {
      this.setProgramCounter(value);
      return;
    }
    if (lower === 'lr' || lower === 'x30') {
      this.setX(30, value, true);
      return;
    }
    if (lower === 'fp' || lower === 'x29') {
      this.setX(29, value, true);
      return;
    }
    if (lower === 'nzcv' || lower === 'pstate' || lower === 'cpsr') {
      this.n = ((value >> 31n) & 1n) === 1n;
      this.z = ((value >> 30n) & 1n) === 1n;
      this.c = ((value >> 29n) & 1n) === 1n;
      this.v = ((value >> 28n) & 1n) === 1n;
      return;
    }

    if (lower.startsWith('x')) {
      const idx = parseInt(lower.slice(1), 10);
      if (!isNaN(idx) && idx >= 0 && idx < 31) {
        this.setX(idx, value, true);
      } else if (idx === 31) {
        this.setSP(value);
      }
    } else if (lower.startsWith('w')) {
      const idx = parseInt(lower.slice(1), 10);
      if (!isNaN(idx) && idx >= 0 && idx < 31) {
        this.setX(idx, value, false);
      } else if (idx === 31) {
        this.setSP(value & MASK_32);
      }
    }
  }

  reset(vector: Address64): void {
    assertValidAddress64(vector, 'AArch64 reset vector');
    this.pc = vector;
    this.x.fill(0n);
    this.sp = 0n;
    this.n = false;
    this.z = false;
    this.c = false;
    this.v = false;
    this.cyclesExecuted = 0n;
    this.state = Frt64CoreRunState.RESET;
  }

  halt(): void {
    this.state = Frt64CoreRunState.HALTED;
  }

  pause(): void {
    if (this.state === Frt64CoreRunState.RUNNING) {
      this.state = Frt64CoreRunState.PAUSED;
    }
  }

  resume(): void {
    if (
      this.state === Frt64CoreRunState.PAUSED ||
      this.state === Frt64CoreRunState.RESET ||
      this.state === Frt64CoreRunState.HALTED
    ) {
      this.state = Frt64CoreRunState.RUNNING;
    }
  }

  getStateSnapshot(): Record<string, unknown> {
    return {
      family: 'ARM_64',
      pc: formatAddress(this.pc),
      sp: formatAddress(this.sp),
      pstate: {
        n: this.n,
        z: this.z,
        c: this.c,
        v: this.v,
      },
      registers: {
        x0: formatAddress(this.x[0]),
        x1: formatAddress(this.x[1]),
        x2: formatAddress(this.x[2]),
        x3: formatAddress(this.x[3]),
        x29_fp: formatAddress(this.x[29]),
        x30_lr: formatAddress(this.x[30]),
      },
      cyclesExecuted: this.cyclesExecuted.toString(),
      state: this.state,
    };
  }

  checkCondition(cond: number): boolean {
    switch (cond & 0xf) {
      case 0x0: return this.z; // EQ
      case 0x1: return !this.z; // NE
      case 0x2: return this.c; // CS / HS
      case 0x3: return !this.c; // CC / LO
      case 0x4: return this.n; // MI
      case 0x5: return !this.n; // PL
      case 0x6: return this.v; // VS
      case 0x7: return !this.v; // VC
      case 0x8: return this.c && !this.z; // HI
      case 0x9: return !this.c || this.z; // LS
      case 0xa: return this.n === this.v; // GE
      case 0xb: return this.n !== this.v; // LT
      case 0xc: return !this.z && (this.n === this.v); // GT
      case 0xd: return this.z || (this.n !== this.v); // LE
      case 0xe: return true; // AL (Always)
      case 0xf: return true; // NV (Always)
      default: return true;
    }
  }

  private setFlagsAdd(a: bigint, b: bigint, is64: boolean): bigint {
    const mask = is64 ? MASK_64 : MASK_32;
    const signBit = is64 ? SIGN_BIT_64 : SIGN_BIT_32;
    const aVal = a & mask;
    const bVal = b & mask;
    const full = aVal + bVal;
    const res = full & mask;

    this.n = ((res >> signBit) & 1n) === 1n;
    this.z = res === 0n;
    this.c = full > mask;
    // Overflow occurs if sign of operands is same and differs from result
    this.v = ((~(aVal ^ bVal) & (aVal ^ res)) >> signBit & 1n) === 1n;
    return res;
  }

  private setFlagsSub(a: bigint, b: bigint, is64: boolean): bigint {
    const mask = is64 ? MASK_64 : MASK_32;
    const signBit = is64 ? SIGN_BIT_64 : SIGN_BIT_32;
    const aVal = a & mask;
    const bVal = b & mask;
    const full = aVal - bVal;
    const res = (full + (mask + 1n)) & mask;

    this.n = ((res >> signBit) & 1n) === 1n;
    this.z = res === 0n;
    // In ARM64 subtraction, Carry is set if there is NO borrow (aVal >= bVal)
    this.c = aVal >= bVal;
    // Overflow occurs if signs of a and b were different, and sign of result differs from a
    this.v = (((aVal ^ bVal) & (aVal ^ res)) >> signBit & 1n) === 1n;
    return res;
  }

  private setFlagsLogic(res: bigint, is64: boolean): bigint {
    const mask = is64 ? MASK_64 : MASK_32;
    const signBit = is64 ? SIGN_BIT_64 : SIGN_BIT_32;
    const resMasked = res & mask;
    this.n = ((resMasked >> signBit) & 1n) === 1n;
    this.z = resMasked === 0n;
    this.c = false;
    this.v = false;
    return resMasked;
  }

  step(): ExecutionStepResult {
    if (this.state === Frt64CoreRunState.HALTED) {
      return {executed: false, state: this.state, reason: 'HALTED', pc: this.pc, cyclesExecuted: this.cyclesExecuted};
    }
    if (this.state === Frt64CoreRunState.PAUSED) {
      return {executed: false, state: this.state, reason: 'PAUSED', pc: this.pc, cyclesExecuted: this.cyclesExecuted};
    }
    if (this.state === Frt64CoreRunState.FAULT) {
      return {executed: false, state: this.state, reason: 'FAULT', pc: this.pc, cyclesExecuted: this.cyclesExecuted};
    }

    // AArch64 requires 4-byte PC alignment
    if (this.pc % 4n !== 0n) {
      this.state = Frt64CoreRunState.FAULT;
      return {
        executed: false,
        state: this.state,
        reason: 'INVALID_INSTRUCTION',
        fault: `Unaligned PC: ${formatAddress(this.pc)} (AArch64 instructions must be 4-byte aligned)`,
        pc: this.pc,
        cyclesExecuted: this.cyclesExecuted,
      };
    }

    let instBytes: Uint8Array;
    try {
      instBytes = this.busMaster.fetchInstructionPhysical(this.pc, 4, this.accessContext);
    } catch (err: unknown) {
      this.state = Frt64CoreRunState.FAULT;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        executed: false,
        state: this.state,
        reason: 'MEMORY_FAULT',
        fault: `Instruction fetch memory fault at ${formatAddress(this.pc)}: ${msg}`,
        pc: this.pc,
        cyclesExecuted: this.cyclesExecuted,
      };
    }

    const opcode = (
      instBytes[0] |
      (instBytes[1] << 8) |
      (instBytes[2] << 16) |
      (instBytes[3] << 24)
    ) >>> 0;

    const currentPc = this.pc;
    let nextPc = currentPc + 4n;
    let disassembly = 'unknown';

    try {
      // 1. NOP / SYSTEM HINT: 0xd503201f
      if (opcode === 0xd503201f) {
        disassembly = 'nop';
      } else if (opcode === 0xd503203f) {
        disassembly = 'yield';
      } else if (opcode === 0xd503205f) {
        disassembly = 'wfe';
      } else if (opcode === 0xd503207f) {
        disassembly = 'wfi';
      }

      // 2. HLT (Halt execution): 0xd4400000 | (imm16 << 5)
      else if (((opcode & 0xffe0001f) >>> 0) === 0xd4400000) {
        const imm16 = (opcode >> 5) & 0xffff;
        disassembly = `hlt #0x${imm16.toString(16)}`;
        this.pc = nextPc;
        this.cyclesExecuted += 1n;
        this.state = Frt64CoreRunState.HALTED;
        return {
          executed: true,
          state: Frt64CoreRunState.HALTED,
          reason: 'HALTED',
          cyclesExecuted: this.cyclesExecuted,
          pc: this.pc,
          opcode,
          disassembly,
        };
      }

      // 3. BRK (Software breakpoint): 0xd4200000 | (imm16 << 5)
      else if (((opcode & 0xffe0001f) >>> 0) === 0xd4200000) {
        const imm16 = (opcode >> 5) & 0xffff;
        disassembly = `brk #0x${imm16.toString(16)}`;
        this.state = Frt64CoreRunState.FAULT;
        return {
          executed: false,
          state: Frt64CoreRunState.FAULT,
          reason: 'FAULT',
          fault: `Software breakpoint BRK #0x${imm16.toString(16)} at ${formatAddress(currentPc)}`,
          pc: this.pc,
          opcode,
          disassembly,
        };
      }

      // 4. MOVZ (Move Wide with Zero): [sf:1] 10 100101 [hw:2] [imm16:16] [Rd:5]
      else if ((opcode & 0x7f800000) === 0x52800000) {
        const sf = (opcode >> 31) & 1;
        const hw = (opcode >> 21) & 3;
        const imm16 = (opcode >> 5) & 0xffff;
        const rd = opcode & 0x1f;
        const shift = hw * 16;
        const val = BigInt(imm16) << BigInt(shift);
        this.setX(rd, val, sf === 1);
        disassembly = `movz ${sf ? 'x' : 'w'}${rd}, #0x${imm16.toString(16)}${shift ? ', lsl #' + shift : ''}`;
      }

      // 5. MOVN (Move Wide with NOT): [sf:1] 00 100101 [hw:2] [imm16:16] [Rd:5]
      else if ((opcode & 0x7f800000) === 0x12800000) {
        const sf = (opcode >> 31) & 1;
        const hw = (opcode >> 21) & 3;
        const imm16 = (opcode >> 5) & 0xffff;
        const rd = opcode & 0x1f;
        const shift = hw * 16;
        const val = ~(BigInt(imm16) << BigInt(shift));
        this.setX(rd, val, sf === 1);
        disassembly = `movn ${sf ? 'x' : 'w'}${rd}, #0x${imm16.toString(16)}${shift ? ', lsl #' + shift : ''}`;
      }

      // 6. MOVK (Move Wide with Keep): [sf:1] 11 100101 [hw:2] [imm16:16] [Rd:5]
      else if ((opcode & 0x7f800000) === 0x72800000) {
        const sf = (opcode >> 31) & 1;
        const hw = (opcode >> 21) & 3;
        const imm16 = (opcode >> 5) & 0xffff;
        const rd = opcode & 0x1f;
        const shift = hw * 16;
        const current = this.getX(rd);
        const clearMask = ~(0xffffn << BigInt(shift));
        const val = (current & clearMask) | (BigInt(imm16) << BigInt(shift));
        this.setX(rd, val, sf === 1);
        disassembly = `movk ${sf ? 'x' : 'w'}${rd}, #0x${imm16.toString(16)}${shift ? ', lsl #' + shift : ''}`;
      }

      // 7. ADD / SUB / ADDS / SUBS (Immediate): [sf:1] [op:1] [S:1] 100010 [shift:2] [imm12:12] [Rn:5] [Rd:5]
      else if ((opcode & 0x1f000000) === 0x11000000) {
        const sf = (opcode >> 31) & 1;
        const op = (opcode >> 30) & 1;
        const s = (opcode >> 29) & 1;
        const shift = (opcode >> 22) & 3;
        const imm12 = (opcode >> 10) & 0xfff;
        const rn = (opcode >> 5) & 0x1f;
        const rd = opcode & 0x1f;
        const imm = BigInt(imm12) << (shift === 1 ? 12n : 0n);
        const valN = rn === 31 ? this.getSP() : this.getX(rn);

        if (op === 0) {
          // ADD / ADDS
          if (s === 1) {
            const res = this.setFlagsAdd(valN, imm, sf === 1);
            if (rd !== 31) this.setX(rd, res, sf === 1);
            disassembly = `adds ${sf ? 'x' : 'w'}${rd}, ${rn === 31 ? 'sp' : (sf ? 'x' : 'w') + rn}, #0x${imm12.toString(16)}`;
          } else {
            const res = valN + imm;
            if (rd === 31) this.setSP(res); else this.setX(rd, res, sf === 1);
            disassembly = `add ${rd === 31 ? 'sp' : (sf ? 'x' : 'w') + rd}, ${rn === 31 ? 'sp' : (sf ? 'x' : 'w') + rn}, #0x${imm12.toString(16)}`;
          }
        } else {
          // SUB / SUBS / CMP
          if (s === 1) {
            const res = this.setFlagsSub(valN, imm, sf === 1);
            if (rd === 31) {
              disassembly = `cmp ${rn === 31 ? 'sp' : (sf ? 'x' : 'w') + rn}, #0x${imm12.toString(16)}`;
            } else {
              this.setX(rd, res, sf === 1);
              disassembly = `subs ${sf ? 'x' : 'w'}${rd}, ${rn === 31 ? 'sp' : (sf ? 'x' : 'w') + rn}, #0x${imm12.toString(16)}`;
            }
          } else {
            const res = valN - imm;
            if (rd === 31) this.setSP(res); else this.setX(rd, res, sf === 1);
            disassembly = `sub ${rd === 31 ? 'sp' : (sf ? 'x' : 'w') + rd}, ${rn === 31 ? 'sp' : (sf ? 'x' : 'w') + rn}, #0x${imm12.toString(16)}`;
          }
        }
      }

      // 8. ADD / SUB / ADDS / SUBS (Shifted Register): [sf:1] [op:1] [S:1] 01011 [shift:2] 0 [Rm:5] [imm6:6] [Rn:5] [Rd:5]
      else if ((opcode & 0x1f200000) === 0x0b000000) {
        const sf = (opcode >> 31) & 1;
        const op = (opcode >> 30) & 1;
        const s = (opcode >> 29) & 1;
        const shiftType = (opcode >> 22) & 3;
        const rm = (opcode >> 16) & 0x1f;
        const imm6 = (opcode >> 10) & 0x3f;
        const rn = (opcode >> 5) & 0x1f;
        const rd = opcode & 0x1f;

        let valM = this.getX(rm);
        if (shiftType === 0) valM = valM << BigInt(imm6);
        else if (shiftType === 1) valM = valM >> BigInt(imm6);
        else if (shiftType === 2) {
          const signBit = sf ? SIGN_BIT_64 : SIGN_BIT_32;
          const isNeg = ((valM >> signBit) & 1n) === 1n;
          valM = valM >> BigInt(imm6);
          if (isNeg) {
            const pad = (sf ? MASK_64 : MASK_32) ^ ((1n << (BigInt(sf ? 64 : 32) - BigInt(imm6))) - 1n);
            valM |= pad;
          }
        }

        const valN = this.getX(rn);
        if (op === 0) {
          if (s === 1) {
            const res = this.setFlagsAdd(valN, valM, sf === 1);
            this.setX(rd, res, sf === 1);
            disassembly = `adds ${sf ? 'x' : 'w'}${rd}, ${sf ? 'x' : 'w'}${rn}, ${sf ? 'x' : 'w'}${rm}`;
          } else {
            const res = valN + valM;
            this.setX(rd, res, sf === 1);
            disassembly = `add ${sf ? 'x' : 'w'}${rd}, ${sf ? 'x' : 'w'}${rn}, ${sf ? 'x' : 'w'}${rm}`;
          }
        } else {
          if (s === 1) {
            const res = this.setFlagsSub(valN, valM, sf === 1);
            if (rd === 31) {
              disassembly = `cmp ${sf ? 'x' : 'w'}${rn}, ${sf ? 'x' : 'w'}${rm}`;
            } else {
              this.setX(rd, res, sf === 1);
              disassembly = `subs ${sf ? 'x' : 'w'}${rd}, ${sf ? 'x' : 'w'}${rn}, ${sf ? 'x' : 'w'}${rm}`;
            }
          } else {
            const res = valN - valM;
            this.setX(rd, res, sf === 1);
            disassembly = `sub ${sf ? 'x' : 'w'}${rd}, ${sf ? 'x' : 'w'}${rn}, ${sf ? 'x' : 'w'}${rm}`;
          }
        }
      }

      // 9. LOGICAL (Shifted Register: AND, BIC, ORR, ORN, EOR, EON, ANDS, BICS): [sf:1] [opc:2] 01010 [shift:2] [N:1] [Rm:5] [imm6:6] [Rn:5] [Rd:5]
      else if ((opcode & 0x1f000000) === 0x0a000000) {
        const sf = (opcode >> 31) & 1;
        const opc = (opcode >> 29) & 3;
        const n = (opcode >> 21) & 1;
        const rm = (opcode >> 16) & 0x1f;
        const rn = (opcode >> 5) & 0x1f;
        const rd = opcode & 0x1f;

        let valM = this.getX(rm);
        if (n === 1) valM = ~valM;
        const valN = this.getX(rn);
        let res = 0n;

        if (opc === 0) res = valN & valM; // AND / BIC
        else if (opc === 1) res = valN | valM; // ORR / ORN (e.g. MOV Rd, Rm when rn=31, n=0)
        else if (opc === 2) res = valN ^ valM; // EOR / EON
        else if (opc === 3) {
          // ANDS / BICS / TST
          res = this.setFlagsLogic(valN & valM, sf === 1);
          if (rd === 31) {
            disassembly = `tst ${sf ? 'x' : 'w'}${rn}, ${sf ? 'x' : 'w'}${rm}`;
          } else {
            this.setX(rd, res, sf === 1);
            disassembly = `ands ${sf ? 'x' : 'w'}${rd}, ${sf ? 'x' : 'w'}${rn}, ${sf ? 'x' : 'w'}${rm}`;
          }
        }

        if (opc !== 3) {
          this.setX(rd, res, sf === 1);
          if (opc === 1 && rn === 31 && n === 0) {
            disassembly = `mov ${sf ? 'x' : 'w'}${rd}, ${sf ? 'x' : 'w'}${rm}`;
          } else {
            const names = ['and', 'orr', 'eor'];
            disassembly = `${names[opc]} ${sf ? 'x' : 'w'}${rd}, ${sf ? 'x' : 'w'}${rn}, ${sf ? 'x' : 'w'}${rm}`;
          }
        }
      }

      // 10. UNCONDITIONAL BRANCH (B): 000101 [imm26:26]
      else if ((opcode & 0xfc000000) === 0x14000000) {
        let imm26 = opcode & 0x03ffffff;
        if (imm26 & 0x02000000) imm26 |= ~0x03ffffff; // sign extend 26 bits
        const offset = BigInt(imm26) * 4n;
        nextPc = currentPc + offset;
        disassembly = `b ${formatAddress(nextPc)}`;
      }

      // 11. BRANCH WITH LINK (BL): 100101 [imm26:26]
      else if (((opcode & 0xfc000000) >>> 0) === 0x94000000) {
        let imm26 = opcode & 0x03ffffff;
        if (imm26 & 0x02000000) imm26 |= ~0x03ffffff;
        const offset = BigInt(imm26) * 4n;
        this.setX(30, currentPc + 4n, true); // LR = next PC
        nextPc = currentPc + offset;
        disassembly = `bl ${formatAddress(nextPc)}`;
      }

      // 12. CONDITIONAL BRANCH (B.cond): 01010100 [imm19:19] 0 [cond:4]
      else if (((opcode & 0xff000010) >>> 0) === 0x54000000) {
        const cond = opcode & 0xf;
        let imm19 = (opcode >> 5) & 0x7ffff;
        if (imm19 & 0x40000) imm19 |= ~0x7ffff; // sign extend 19 bits
        const offset = BigInt(imm19) * 4n;
        const taken = this.checkCondition(cond);
        if (taken) {
          nextPc = currentPc + offset;
        } else {
          nextPc = currentPc + 4n;
        }
        disassembly = `b.cond_${cond} ${formatAddress(currentPc + offset)} (${taken ? 'taken' : 'not taken'})`;
      }

      // 13. COMPARE AND BRANCH ON ZERO / NON-ZERO (CBZ / CBNZ): [sf:1] 011010 [op:1] [imm19:19] [Rt:5]
      else if (((opcode & 0x7e000000) >>> 0) === 0x34000000) {
        const sf = (opcode >> 31) & 1;
        const isCbnz = ((opcode >> 24) & 1) === 1;
        let imm19 = (opcode >> 5) & 0x7ffff;
        if (imm19 & 0x40000) imm19 |= ~0x7ffff;
        const rt = opcode & 0x1f;
        const offset = BigInt(imm19) * 4n;
        const val = sf ? this.getX(rt) : (this.getX(rt) & MASK_32);
        const taken = isCbnz ? (val !== 0n) : (val === 0n);
        if (taken) {
          nextPc = currentPc + offset;
        } else {
          nextPc = currentPc + 4n;
        }
        disassembly = `${isCbnz ? 'cbnz' : 'cbz'} ${sf ? 'x' : 'w'}${rt}, ${formatAddress(currentPc + offset)}`;
      }

      // 14. UNCONDITIONAL BRANCH REGISTER (RET, BR, BLR): 1101011 00 [opc:2] 11111 000000 [Rn:5] 00000
      else if (((opcode & 0xfffffc1f) >>> 0) === 0xd65f0000) {
        // RET
        const rn = (opcode >> 5) & 0x1f;
        nextPc = this.getX(rn);
        disassembly = `ret ${rn === 30 ? '' : 'x' + rn}`.trim();
      } else if (((opcode & 0xfffffc1f) >>> 0) === 0xd61f0000) {
        // BR
        const rn = (opcode >> 5) & 0x1f;
        nextPc = this.getX(rn);
        disassembly = `br x${rn}`;
      } else if (((opcode & 0xfffffc1f) >>> 0) === 0xd63f0000) {
        // BLR
        const rn = (opcode >> 5) & 0x1f;
        this.setX(30, currentPc + 4n, true);
        nextPc = this.getX(rn);
        disassembly = `blr x${rn}`;
      }

      // 15. LOAD / STORE REGISTER (Unsigned Immediate): 00 111 0 01 [size:2] [V:0] [opc:2] [imm12:12] [Rn:5] [Rt:5]
      else if ((opcode & 0x3b000000) === 0x39000000) {
        const size = (opcode >> 30) & 3; // 0=8-bit, 1=16-bit, 2=32-bit, 3=64-bit
        const opc = (opcode >> 22) & 3; // 0=STR, 1=LDR
        const imm12 = (opcode >> 10) & 0xfff;
        const rn = (opcode >> 5) & 0x1f;
        const rt = opcode & 0x1f;
        const offset = BigInt(imm12) << BigInt(size);
        const base = rn === 31 ? this.getSP() : this.getX(rn);
        const targetAddr = base + offset;
        const byteCount = 1 << size;

        if (opc === 0) {
          // STORE (STRB, STRH, STR)
          const val = this.getX(rt);
          const buf = new Uint8Array(byteCount);
          for (let i = 0; i < byteCount; i++) {
            buf[i] = Number((val >> BigInt(i * 8)) & 0xffn);
          }
          this.busMaster.writePhysical(targetAddr, buf, this.accessContext);
          const mnemonic = ['strb', 'strh', 'str', 'str'][size];
          disassembly = `${mnemonic} ${size === 3 ? 'x' : 'w'}${rt}, [${rn === 31 ? 'sp' : 'x' + rn}, #0x${offset.toString(16)}]`;
        } else if (opc === 1) {
          // LOAD (LDRB, LDRH, LDR)
          const buf = this.busMaster.readPhysical(targetAddr, byteCount, this.accessContext);
          let val = 0n;
          for (let i = 0; i < byteCount; i++) {
            val |= BigInt(buf[i]) << BigInt(i * 8);
          }
          this.setX(rt, val, size === 3);
          const mnemonic = ['ldrb', 'ldrh', 'ldr', 'ldr'][size];
          disassembly = `${mnemonic} ${size === 3 ? 'x' : 'w'}${rt}, [${rn === 31 ? 'sp' : 'x' + rn}, #0x${offset.toString(16)}]`;
        } else {
          throw new Error(`Unsupported load/store opcode variant: opc=${opc}`);
        }
      }

      // 16. LOAD / STORE REGISTER PAIR (LDP / STP): [opc:2] 101 0 [mode:3] [L:1] [imm7:7] [Rt2:5] [Rn:5] [Rt:5]
      else if ((opcode & 0x3e000000) === 0x28000000 || (opcode & 0x3e000000) === 0x29000000) {
        const opc = (opcode >> 30) & 3; // 0=32-bit, 2=64-bit
        const isLoad = ((opcode >> 22) & 1) === 1;
        const mode = (opcode >> 23) & 3; // 1=post-index, 2=signed offset, 3=pre-index
        let imm7 = (opcode >> 15) & 0x7f;
        if (imm7 & 0x40) imm7 |= ~0x7f; // sign extend 7 bits
        const rt2 = (opcode >> 10) & 0x1f;
        const rn = (opcode >> 5) & 0x1f;
        const rt = opcode & 0x1f;
        const scale = opc === 2 ? 3 : 2;
        const byteCount = 1 << scale;
        const offset = BigInt(imm7) << BigInt(scale);
        const base = rn === 31 ? this.getSP() : this.getX(rn);

        let targetAddr = base;
        if (mode === 2 || mode === 3) {
          targetAddr = base + offset;
        }

        if (isLoad) {
          // LDP
          const buf1 = this.busMaster.readPhysical(targetAddr, byteCount, this.accessContext);
          const buf2 = this.busMaster.readPhysical(targetAddr + BigInt(byteCount), byteCount, this.accessContext);
          let val1 = 0n;
          let val2 = 0n;
          for (let i = 0; i < byteCount; i++) {
            val1 |= BigInt(buf1[i]) << BigInt(i * 8);
            val2 |= BigInt(buf2[i]) << BigInt(i * 8);
          }
          this.setX(rt, val1, opc === 2);
          this.setX(rt2, val2, opc === 2);
          disassembly = `ldp ${opc === 2 ? 'x' : 'w'}${rt}, ${opc === 2 ? 'x' : 'w'}${rt2}, [${rn === 31 ? 'sp' : 'x' + rn}]`;
        } else {
          // STP
          const val1 = this.getX(rt);
          const val2 = this.getX(rt2);
          const buf1 = new Uint8Array(byteCount);
          const buf2 = new Uint8Array(byteCount);
          for (let i = 0; i < byteCount; i++) {
            buf1[i] = Number((val1 >> BigInt(i * 8)) & 0xffn);
            buf2[i] = Number((val2 >> BigInt(i * 8)) & 0xffn);
          }
          this.busMaster.writePhysical(targetAddr, buf1, this.accessContext);
          this.busMaster.writePhysical(targetAddr + BigInt(byteCount), buf2, this.accessContext);
          disassembly = `stp ${opc === 2 ? 'x' : 'w'}${rt}, ${opc === 2 ? 'x' : 'w'}${rt2}, [${rn === 31 ? 'sp' : 'x' + rn}]`;
        }

        // Handle writeback for pre-index (3) or post-index (1)
        if (mode === 1 || mode === 3) {
          const newBase = base + offset;
          if (rn === 31) this.setSP(newBase); else this.setX(rn, newBase, true);
        }
      }

      else {
        // Unknown or unimplemented instruction opcode
        this.state = Frt64CoreRunState.FAULT;
        return {
          executed: false,
          state: Frt64CoreRunState.FAULT,
          reason: 'INVALID_INSTRUCTION',
          fault: `Undefined or unsupported AArch64 opcode 0x${opcode.toString(16).padStart(8, '0')} at ${formatAddress(currentPc)}`,
          pc: this.pc,
          opcode,
          cyclesExecuted: this.cyclesExecuted,
        };
      }
    } catch (err: unknown) {
      this.state = Frt64CoreRunState.FAULT;
      const msg = err instanceof Error ? err.message : String(err);
      return {
        executed: false,
        state: this.state,
        reason: 'MEMORY_FAULT',
        fault: `Memory fault executing instruction 0x${opcode.toString(16)} at ${formatAddress(currentPc)}: ${msg}`,
        pc: this.pc,
        opcode,
        cyclesExecuted: this.cyclesExecuted,
      };
    }

    this.pc = nextPc;
    this.cyclesExecuted += 1n;
    this.state = Frt64CoreRunState.RUNNING;

    return {
      executed: true,
      state: this.state,
      reason: 'OK',
      cyclesExecuted: this.cyclesExecuted,
      pc: this.pc,
      opcode,
      disassembly,
    };
  }

  executeBatch(maxInstructions: number): BoundedBatchResult {
    let count = 0;
    const cyclesStart = this.cyclesExecuted;
    let stoppedReason: ExecutionStepReason = 'OK';

    for (let i = 0; i < maxInstructions; i++) {
      if (this.state === Frt64CoreRunState.HALTED) {
        stoppedReason = 'HALTED';
        break;
      }
      if (this.state === Frt64CoreRunState.PAUSED) {
        stoppedReason = 'PAUSED';
        break;
      }
      if (this.state === Frt64CoreRunState.FAULT) {
        stoppedReason = 'FAULT';
        break;
      }

      const res = this.step();
      if (!res.executed) {
        stoppedReason = res.reason;
        break;
      }
      count++;
    }

    return {
      instructionsExecuted: count,
      cyclesExecuted: this.cyclesExecuted - cyclesStart,
      finalState: this.state,
      lastPc: this.pc,
      stoppedReason,
    };
  }
}

/**
 * Fallback engine for non-ARM64 families.
 * Truthfully fails with UNSUPPORTED_EXECUTION_FAMILY rather than pretending execution.
 */
export class UnsupportedFrt64Engine implements IFrt64ExecutionEngine {
  readonly family: Frt64ExecutionFamily;
  readonly coreId: number;
  pc: Address64;
  state = Frt64CoreRunState.RESET;

  constructor(family: Frt64ExecutionFamily, coreId: number, initialPc: Address64) {
    this.family = family;
    this.coreId = coreId;
    this.pc = initialPc;
  }

  setProgramCounter(address: Address64): void {
    this.pc = address;
  }

  getRegister(): bigint {
    return 0n;
  }

  setRegister(_nameOrIndex: string | number, _value: bigint): void {
    void _nameOrIndex;
    void _value;
  }

  reset(vector: Address64): void {
    this.pc = vector;
    this.state = Frt64CoreRunState.RESET;
  }

  halt(): void {
    this.state = Frt64CoreRunState.HALTED;
  }

  pause(): void {
    this.state = Frt64CoreRunState.PAUSED;
  }

  resume(): void {
    this.state = Frt64CoreRunState.RUNNING;
  }

  getStateSnapshot(): Record<string, unknown> {
    return {
      family: this.family,
      supported: false,
      pc: formatAddress(this.pc),
    };
  }

  step(): ExecutionStepResult {
    this.state = Frt64CoreRunState.FAULT;
    return {
      executed: false,
      state: Frt64CoreRunState.FAULT,
      reason: 'UNSUPPORTED_EXECUTION_FAMILY',
      fault: `Execution family ${this.family} has no attached CPU emulator backend in this platform instance.`,
      pc: this.pc,
      cyclesExecuted: 0n,
    };
  }

  executeBatch(): BoundedBatchResult {
    this.state = Frt64CoreRunState.FAULT;
    return {
      instructionsExecuted: 0,
      cyclesExecuted: 0n,
      finalState: Frt64CoreRunState.FAULT,
      lastPc: this.pc,
      stoppedReason: 'UNSUPPORTED_EXECUTION_FAMILY',
    };
  }
}

export function createExecutionEngine(
  family: Frt64ExecutionFamily,
  coreId: number,
  busMaster: IFrt64BusMaster,
  accessContext: CpuAccessContext,
  initialPc: Address64
): IFrt64ExecutionEngine {
  if (family === Frt64ExecutionFamily.ARM_64) {
    return new AArch64ExecutionEngine(coreId, busMaster, accessContext, initialPc);
  }
  return new UnsupportedFrt64Engine(family, coreId, initialPc);
}
