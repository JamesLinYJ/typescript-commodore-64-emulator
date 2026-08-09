// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - NMOS 6502/6510 CPU 执行核心
//
//   文件:       Cpu6502.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { MemoryBus } from '../memory/MemoryBus';
import { TypedEventEmitter } from '../../shared/TypedEventEmitter';
import { hex, word } from '../../shared/numbers';
import { BreakpointError } from './BreakpointError';
import { CPU_POWER_ON_STATE, CPU_RESET_SEQUENCE, CPU_VECTOR, CpuStatusFlag } from './cpuConstants';
import { CpuInterruptTiming } from './CpuInterruptTiming';
import { CpuOpcode, type AddressingMode } from './CpuOpcode';
import {
  CPU_ADDRESS_MODE as CycleAddressMode,
  CPU_MEMORY_ACCESS as CycleMemoryAccess,
  CPU_OPCODE_FLAG,
  CPU_OPCODE_FLAGS,
  CPU_OPCODE_OPERATION,
  CPU_OPCODE_PLAN,
  CPU_OPCODE_PLAN_ACCESS_MASK,
  CPU_OPCODE_PLAN_ACCESS_SHIFT,
  CPU_OPCODE_PLAN_MODE_MASK,
  CPU_OPCODE_PLAN_MODE_SHIFT,
  CPU_OPERATION as CycleOperation,
} from './CpuOpcodeMetadata';
import type { CpuRegisters } from './CpuRegisters';

interface CpuEvents {
  readonly reset: {
    readonly previousProgramCounter: number;
    readonly programCounter: number;
  };
}

export type CpuInstructionObserver = (address: number, opcode: number) => void;
export type CpuNmiTakeoverProbe = () => boolean;
export type CpuReadWasHeldProbe = () => boolean;

const NO_ADDRESSING_MODE: AddressingMode = () => 0;
const CPU_BYTE_MAX = 0xff;
const CPU_ADDRESS_MAX = 0xffff;
const CPU_PAGE_SIZE = 0x100;
const CPU_PAGE_OFFSET_MASK = CPU_PAGE_SIZE - 1;
const CPU_PAGE_SHIFT = 8;
const CPU_LOW_NIBBLE_MASK = 0x0f;
const CPU_HIGH_NIBBLE_MASK = 0xf0;
const CPU_NIBBLE_BIT_COUNT = 4;
const CPU_NIBBLE_CARRY = 0x10;
const BCD_DIGIT_BASE = 0x0a;
const BCD_LOW_DIGIT_ADJUSTMENT = 0x06;
const BCD_HIGH_DIGIT_THRESHOLD = 0xa0;
const BCD_HIGH_DIGIT_ADJUSTMENT = 0x60;
const ARR_LOW_DIGIT_THRESHOLD = 0x05;
const ARR_HIGH_DIGIT_THRESHOLD = 0x50;
const ARR_CARRY_SOURCE_MASK = 0x40;
const NMOS_UNSTABLE_DATA_MASK = 0xee;
const CPU_JAM_TRANSIENT_BUS_ADDRESSES = [0xffff, 0xfffe, 0xfffe] as const;
const CPU_JAM_STABLE_BUS_ADDRESS = 0xffff;

const enum CpuMemoryAccess {
  Read,
  Write,
  ReadModifyWrite,
}

const enum CpuUnstableStoreDataMaskMode {
  Always,
  DropAfterHeldRead,
}

const enum CpuCycleSequence {
  None,
  NonMaskableInterrupt,
  MaskableInterrupt,
}

export class Cpu6502 extends TypedEventEmitter<CpuEvents> {
  private a = 0;
  private x = 0;
  private y = 0;
  private p = 0;
  private sp = 0;
  private cyclesConsumed = 0;
  private useUndocumentedOpcodes = true;
  private readonly breakpointTable = new Uint8Array(0x1_0000);
  private readonly memory: MemoryBus;
  private readonly opcodes: readonly CpuOpcode[];
  private readonly znTable: Uint8Array;
  private instructionObserver: CpuInstructionObserver | undefined;
  private nmiTakeoverProbe: CpuNmiTakeoverProbe | undefined;
  private readWasHeldProbe: CpuReadWasHeldProbe | undefined;
  private jamBusCycleIndex = 0;
  private jammed = false;
  private memoryAccess = CpuMemoryAccess.Read;
  private readonly interruptTiming = new CpuInterruptTiming();
  private cycleOpcode = 0;
  private cycleOperation: number = CycleOperation.NOP;
  private cycleAddressMode: number = CycleAddressMode.IMP;
  private cycleMemoryAccess: number = CycleMemoryAccess.NONE;
  private cyclePhase = 0;
  private cycleCurrentCycles = 0;
  private cycleAddress = 0;
  private cycleBaseAddress = 0;
  private cycleProvisionalAddress = 0;
  private cycleLow = 0;
  private cycleData = 0;
  private cyclePageCrossed = false;
  private cycleIndexedStoreReadWasHeld = false;
  private cycleInterruptMaskedBefore = false;
  private cycleCheckBreakpoints = false;
  private cycleSequence = CpuCycleSequence.None;
  private cycleSequencePhase = 0;
  pc = 0;

  constructor(mm: MemoryBus) {
    super();
    this.memory = mm;
    this.useUndocumentedOpcodes = true;
    this.opcodes = this.getOpcodeTable();
    this.znTable = this.getTwoComplementTable();

    // 构造使用确定性的上电状态；紧随其后的 RESET 仍通过七个真实读周期进入向量。
    this.a = CPU_POWER_ON_STATE.accumulator;
    this.x = CPU_POWER_ON_STATE.indexX;
    this.y = CPU_POWER_ON_STATE.indexY;
    this.p = CPU_POWER_ON_STATE.status;
    this.sp = CPU_POWER_ON_STATE.stackPointer;
    this.pc = CPU_POWER_ON_STATE.programCounter;
    this.cyclesConsumed = 0;

    this.reset();
  }

  /**
   * 指示逐周期执行器是否停在可接收新指令或硬件中断的边界。
   * KIL/JAM 不形成边界，必须由复位解除。
   */
  get isAtInstructionBoundary(): boolean {
    return !this.jammed && this.cyclePhase === 0 && this.cycleSequence === CpuCycleSequence.None;
  }

  /**
   * 推进一个 NMOS 6502 总线周期。
   *
   * 每次调用恰好执行一次 read 或 write；返回 true 表示该周期形成了新的指令
   * 或硬件中断边界。热路径仅更新预分配的标量状态。
   */
  clockCycle(checkBreakpoints = false): boolean {
    if (this.cycleSequence !== CpuCycleSequence.None) {
      return this.tickCycleInterruptSequence();
    }
    if (this.jammed) {
      this.executeJammedBusCycle();
      return false;
    }
    if (this.cyclePhase === 0) {
      this.cycleIndexedStoreReadWasHeld = false;
      const instructionAddress = this.pc;
      this.pc = word(this.pc + 1);
      this.cycleInterruptMaskedBefore = (this.p & CpuStatusFlag.InterruptDisable) !== 0;
      this.interruptTiming.beginInstruction();
      this.cycleOpcode = this.memory.read(instructionAddress);
      this.instructionObserver?.(instructionAddress, this.cycleOpcode);
      this.cycleOperation = CPU_OPCODE_OPERATION[this.cycleOpcode] ?? CycleOperation.JAM;
      const plan = CPU_OPCODE_PLAN[this.cycleOpcode] ?? 0;
      this.cycleAddressMode = (plan >>> CPU_OPCODE_PLAN_MODE_SHIFT) & CPU_OPCODE_PLAN_MODE_MASK;
      this.cycleMemoryAccess =
        (plan >>> CPU_OPCODE_PLAN_ACCESS_SHIFT) & CPU_OPCODE_PLAN_ACCESS_MASK;
      this.cyclePhase = 1;
      this.cycleCurrentCycles = 1;
      this.cycleCheckBreakpoints = checkBreakpoints;
      if (
        !this.useUndocumentedOpcodes &&
        ((CPU_OPCODE_FLAGS[this.cycleOpcode] ?? 0) & CPU_OPCODE_FLAG.UNDOCUMENTED) !== 0 &&
        this.cycleOperation !== CycleOperation.JAM &&
        this.cycleOperation !== CycleOperation.SBC
      ) {
        this.usedUndocumentedOpcode();
      }
      return false;
    }

    this.cycleCurrentCycles += 1;
    return this.cycleMemoryAccess === CycleMemoryAccess.NONE
      ? this.tickCycleSpecial()
      : this.tickCycleAddressed();
  }

  /** 从指令边界启动七周期 NMI 微序列。 */
  beginNonMaskableInterruptSequence(): boolean {
    if (this.jammed) return false;
    this.beginCycleInterruptSequence(CpuCycleSequence.NonMaskableInterrupt);
    return true;
  }

  /** 从已通过外部采样裁决的指令边界启动七周期 IRQ 微序列。 */
  beginMaskableInterruptSequence(): boolean {
    if (this.jammed) return false;
    this.beginCycleInterruptSequence(CpuCycleSequence.MaskableInterrupt);
    return true;
  }

  private beginCycleInterruptSequence(sequence: CpuCycleSequence): void {
    if (!this.isAtInstructionBoundary) {
      throw new Error('CPU interrupt sequence must begin at an instruction boundary.');
    }
    this.cycleSequence = sequence;
    this.cycleSequencePhase = 0;
    this.cycleCurrentCycles = 0;
  }

  private tickCycleInterruptSequence(): boolean {
    const phase = ++this.cycleSequencePhase;
    this.cycleCurrentCycles += 1;
    if (phase <= 2) {
      this.memory.read(this.pc);
      return false;
    }
    if (phase === 3) {
      this.push((this.pc >>> CPU_PAGE_SHIFT) & CPU_BYTE_MAX);
      return false;
    }
    if (phase === 4) {
      this.push(this.pc & CPU_BYTE_MAX);
      return false;
    }
    if (phase === 5) {
      this.push((this.p & ~CpuStatusFlag.Break) | CpuStatusFlag.Unused);
      return false;
    }
    if (phase === 6) {
      this.cycleAddress =
        this.cycleSequence === CpuCycleSequence.NonMaskableInterrupt || this.nmiTakeoverProbe?.()
          ? CPU_VECTOR.nonMaskableInterrupt
          : CPU_VECTOR.interruptRequest;
      this.cycleLow = this.memory.read(this.cycleAddress);
      return false;
    }

    const high = this.memory.read(word(this.cycleAddress + 1));
    this.pc = this.cycleLow | (high << CPU_PAGE_SHIFT);
    this.p |= CpuStatusFlag.InterruptDisable;
    this.cycleSequence = CpuCycleSequence.None;
    this.cycleSequencePhase = 0;
    this.cyclesConsumed = this.cycleCurrentCycles;
    this.interruptTiming.completeInterruptEntry();
    return true;
  }

  /**
   * 执行 PC 指向的一条指令。
   *
   * @returns 指令实际消耗的 CPU 总线周期数。
   * @throws {BreakpointError} 执行结束后命中已启用的断点。
   */
  executeInstruction(checkBreakpoints = false) {
    if (this.jammed) return this.executeJammedBusCycle();
    this.assertNoActiveCycleSequence();

    const interruptWasMasked = (this.p & CpuStatusFlag.InterruptDisable) !== 0;
    this.interruptTiming.beginInstruction();
    const instructionAddress = this.pc;
    this.pc = word(this.pc + 1);
    const opcode = this.memory.read(instructionAddress);
    this.instructionObserver?.(instructionAddress, opcode);
    const opcodeInfo = this.requireOpcode(opcode);
    this.cyclesConsumed = opcodeInfo.cycles;
    opcodeInfo.execute(opcodeInfo.addressingMode ?? NO_ADDRESSING_MODE);

    // KIL/JAM 没有新的指令边界；中断采样和断点都必须等到硬件复位解除锁死后再发生。
    if (this.jammed) return this.cyclesConsumed;

    const interruptIsMasked = (this.p & CpuStatusFlag.InterruptDisable) !== 0;
    this.interruptTiming.completeInstructionState(interruptIsMasked, interruptWasMasked, opcode);

    // 断点在整条指令及其全部总线周期完成后生效，避免留下半执行状态。
    if (checkBreakpoints && (this.breakpointTable[this.pc] ?? 0) > 0) {
      throw new BreakpointError(this.pc, this.breakpointTable[this.pc] ?? 0, this.cyclesConsumed);
    }
    return this.cyclesConsumed;
  }
  /**
   * 执行一次不可屏蔽中断入口序列。
   *
   * @returns NMI 固定消耗的七个 CPU 周期。
   */
  nmi() {
    this.assertNoActiveCycleSequence();
    if (this.jammed) return 0;

    this.dummyRead(this.pc);
    this.dummyRead(this.pc);
    this.pushWord(this.pc);
    this.push((this.p & ~CpuStatusFlag.Break) | CpuStatusFlag.Unused);
    this.pc = this.memory.readWord(CPU_VECTOR.nonMaskableInterrupt);
    this.p |= CpuStatusFlag.InterruptDisable;
    this.interruptTiming.completeInterruptEntry();
    return 7;
  }
  /**
   * 在 I 标志允许时执行一次可屏蔽 IRQ 入口序列。
   *
   * @returns 已接受 IRQ 时为七个周期，否则为零。
   */
  irq() {
    this.assertNoActiveCycleSequence();
    if ((this.p & CpuStatusFlag.InterruptDisable) === 0) {
      return this.serviceMaskableInterrupt();
    }
    return 0;
  }

  canAcceptMaskableInterrupt(assertedCycles: number): boolean {
    return (
      !this.jammed &&
      this.interruptTiming.canAcceptMaskableInterrupt(
        assertedCycles,
        (this.p & CpuStatusFlag.InterruptDisable) !== 0,
      )
    );
  }

  canAcceptNonMaskableInterrupt(assertedCycles: number): boolean {
    return !this.jammed && this.interruptTiming.canAcceptNonMaskableInterrupt(assertedCycles);
  }

  canTakeOverInterruptSequenceWithNmi(assertedCycles: number): boolean {
    return !this.jammed && this.interruptTiming.canTakeOverInterruptSequenceWithNmi(assertedCycles);
  }

  serviceMaskableInterrupt(): number {
    this.assertNoActiveCycleSequence();
    if (this.jammed) return 0;

    this.dummyRead(this.pc);
    this.dummyRead(this.pc);
    this.pushWord(this.pc);
    this.push((this.p & ~CpuStatusFlag.Break) | CpuStatusFlag.Unused);
    this.pc = this.readBrkOrIrqVector();
    this.p |= CpuStatusFlag.InterruptDisable;
    this.interruptTiming.completeInterruptEntry();
    return 7;
  }

  /**
   * 执行 NMOS 6502/6510 的七周期 RESET 微序列。
   *
   * RESET 把三个原本的压栈写周期变为读周期，但 SP 仍逐次递减。运行中复位不会
   * 初始化 A、X、Y 或其余状态位；只有 I 被强制置位。
   *
   * @returns RESET 固定消耗的七个 CPU 总线周期。
   */
  reset(): number {
    const pcOld = this.pc;
    this.jammed = false;
    this.jamBusCycleIndex = 0;
    this.cyclePhase = 0;
    this.cycleCurrentCycles = 0;
    this.cycleCheckBreakpoints = false;
    this.cycleSequence = CpuCycleSequence.None;
    this.cycleSequencePhase = 0;
    this.memoryAccess = CpuMemoryAccess.Read;
    this.interruptTiming.reset();
    this.p |= CpuStatusFlag.InterruptDisable;

    this.dummyRead(this.pc);
    this.dummyRead(this.pc);
    for (let cycle = 0; cycle < CPU_RESET_SEQUENCE.stackReadCount; cycle += 1) {
      this.dummyRead(CPU_PAGE_SIZE | this.sp);
      this.sp = (this.sp - 1) & CPU_BYTE_MAX;
    }

    const vectorLow = this.memory.read(CPU_VECTOR.reset);
    const vectorHigh = this.memory.read(CPU_VECTOR.reset + 1);
    this.pc = vectorLow | (vectorHigh << CPU_PAGE_SHIFT);
    this.cyclesConsumed = CPU_RESET_SEQUENCE.cycleCount;
    // 事件只在寄存器状态已经一致后发布。
    this.emit('reset', { previousProgramCounter: pcOld, programCounter: this.pc });
    return this.cyclesConsumed;
  }

  /** 返回不暴露内部可变字段的寄存器快照。 */
  getRegisters(): CpuRegisters {
    return {
      accumulator: this.a,
      indexX: this.x,
      indexY: this.y,
      status: this.p,
      stackPointer: this.sp,
      programCounter: this.pc,
    };
  }

  /** KIL/JAM 已锁死 CPU；只有硬件复位或显式恢复寄存器状态才能解除。 */
  get isJammed(): boolean {
    return this.jammed;
  }

  /**
   * 从调试器、快照或单步参考用例装入一个完整的指令边界寄存器状态。
   *
   * 该操作只允许发生在指令边界，并会清除尚未形成 CPU 引脚事件的内部中断采样历史；
   * 它不执行复位向量读取，也不触发 reset 事件。
   */
  restoreRegisters(registers: CpuRegisters): void {
    this.a = requireCpuRegisterByte('A', registers.accumulator);
    this.x = requireCpuRegisterByte('X', registers.indexX);
    this.y = requireCpuRegisterByte('Y', registers.indexY);
    this.p = requireCpuRegisterByte('P', registers.status);
    this.sp = requireCpuRegisterByte('SP', registers.stackPointer);
    this.pc = requireCpuProgramCounter(registers.programCounter);
    this.cyclesConsumed = 0;
    this.jammed = false;
    this.jamBusCycleIndex = 0;
    this.cyclePhase = 0;
    this.cycleCurrentCycles = 0;
    this.cycleCheckBreakpoints = false;
    this.cycleSequence = CpuCycleSequence.None;
    this.cycleSequencePhase = 0;
    this.memoryAccess = CpuMemoryAccess.Read;
    this.interruptTiming.reset();
  }

  /**
   * 响应 NMOS 6502 的 SO（Set Overflow）引脚采样结果。
   *
   * 引脚的边沿检测和传播延迟属于整机时序层；CPU 核只负责把已经确认的有效边沿
   * 反映为 P 寄存器的 V 位。1541 用该引脚通知驱动器 CPU 已锁存一个 GCR 字节。
   */
  signalSetOverflow(): void {
    this.p |= CpuStatusFlag.Overflow;
  }

  /** 在给定 16 位地址设置断点类型。 */
  setBreakpoint(address: number, type?: number) {
    if (typeof type == 'undefined') type = 1;
    this.breakpointTable[address] = type;
  }

  /** 清除给定地址上的断点。 */
  clearBreakpoint(address: number) {
    this.breakpointTable[address] = 0;
  }

  /** 判断给定地址是否存在已启用断点。 */
  getBreakpoint(address: number) {
    return (this.breakpointTable[address] ?? 0) > 0;
  }

  setUseUndocumentedOpcodes(value: boolean) {
    this.useUndocumentedOpcodes = value;
  }

  setInstructionObserver(
    observer: CpuInstructionObserver | undefined,
  ): CpuInstructionObserver | undefined {
    const previous = this.instructionObserver;
    this.instructionObserver = observer;
    return previous;
  }

  /**
   * 安装 BRK/IRQ 向量选择点的 NMI 探针。
   *
   * CPU 只在 P 已压栈、尚未读取向量时调用；物理引脚、识别延迟和边沿确认仍由整机拥有。
   */
  setNmiTakeoverProbe(probe: CpuNmiTakeoverProbe | undefined): CpuNmiTakeoverProbe | undefined {
    const previous = this.nmiTakeoverProbe;
    this.nmiTakeoverProbe = probe;
    return previous;
  }

  /**
   * 安装最近一次 CPU 读周期是否被 RDY 延长的探针。
   *
   * CPU 在需要该相位事实的虚读返回后立即采样；BA/AEC 的推进和仲裁仍由整机负责。
   */
  setReadWasHeldProbe(probe: CpuReadWasHeldProbe | undefined): CpuReadWasHeldProbe | undefined {
    const previous = this.readWasHeldProbe;
    this.readWasHeldProbe = probe;
    return previous;
  }

  getUseUndocumentedOpcodes() {
    return this.useUndocumentedOpcodes;
  }

  private assertNoActiveCycleSequence(): void {
    if (this.cyclePhase !== 0 || this.cycleSequence !== CpuCycleSequence.None) {
      throw new Error('Atomic execution cannot start while a CPU cycle sequence is active.');
    }
  }

  // ------------------------------------------------------------------------
  // 逐总线周期执行器
  // ------------------------------------------------------------------------

  private finishCycleInstruction(): true {
    this.cyclePhase = 0;
    this.cyclesConsumed = this.cycleCurrentCycles;
    const interruptIsMasked = (this.p & CpuStatusFlag.InterruptDisable) !== 0;
    this.interruptTiming.completeInstructionState(
      interruptIsMasked,
      this.cycleInterruptMaskedBefore,
      this.cycleOpcode,
    );
    const checkBreakpoints = this.cycleCheckBreakpoints;
    this.cycleCheckBreakpoints = false;
    if (checkBreakpoints && (this.breakpointTable[this.pc] ?? 0) > 0) {
      throw new BreakpointError(this.pc, this.breakpointTable[this.pc] ?? 0, this.cyclesConsumed);
    }
    return true;
  }

  private readCycleInstructionByte(): number {
    const address = this.pc;
    this.pc = word(this.pc + 1);
    return this.memory.read(address);
  }

  private tickCycleAddressed(): boolean {
    switch (this.cycleAddressMode) {
      case CycleAddressMode.IMM:
        this.cycleData = this.readCycleInstructionByte();
        this.applyCycleRead(this.cycleData);
        return this.finishCycleInstruction();
      case CycleAddressMode.ZP:
        return this.tickCycleZeroPage(false, false);
      case CycleAddressMode.ZPX:
        return this.tickCycleZeroPage(true, false);
      case CycleAddressMode.ZPY:
        return this.tickCycleZeroPage(false, true);
      case CycleAddressMode.ABS:
        return this.tickCycleAbsolute(false, false);
      case CycleAddressMode.ABSX:
        return this.tickCycleAbsolute(true, false);
      case CycleAddressMode.ABSY:
        return this.tickCycleAbsolute(false, true);
      case CycleAddressMode.INDX:
        return this.tickCycleIndirectX();
      case CycleAddressMode.INDY:
        return this.tickCycleIndirectY();
      default:
        throw new Error(`Unsupported cycle addressing mode ${this.cycleAddressMode}.`);
    }
  }

  private tickCycleZeroPage(indexX: boolean, indexY: boolean): boolean {
    const indexed = indexX || indexY;
    if (this.cyclePhase === 1) {
      this.cycleBaseAddress = this.readCycleInstructionByte();
      this.cycleAddress = this.cycleBaseAddress;
      this.cyclePhase = 2;
      return false;
    }
    if (indexed && this.cyclePhase === 2) {
      this.memory.read(this.cycleBaseAddress);
      this.cycleAddress = (this.cycleBaseAddress + (indexX ? this.x : this.y)) & CPU_BYTE_MAX;
      this.cyclePhase = 3;
      return false;
    }
    return this.tickCycleEffectiveAddress(indexed ? 3 : 2);
  }

  private tickCycleAbsolute(indexX: boolean, indexY: boolean): boolean {
    const indexed = indexX || indexY;
    if (this.cyclePhase === 1) {
      this.cycleLow = this.readCycleInstructionByte();
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      const high = this.readCycleInstructionByte();
      this.cycleBaseAddress = this.cycleLow | (high << CPU_PAGE_SHIFT);
      this.cycleAddress = word(this.cycleBaseAddress + (indexX ? this.x : indexY ? this.y : 0));
      this.cycleProvisionalAddress =
        (this.cycleBaseAddress & 0xff00) | (this.cycleAddress & CPU_PAGE_OFFSET_MASK);
      this.cyclePageCrossed = ((this.cycleBaseAddress ^ this.cycleAddress) & CPU_PAGE_SIZE) !== 0;
      this.cyclePhase = 3;
      return false;
    }
    if (
      indexed &&
      this.cyclePhase === 3 &&
      (this.cycleMemoryAccess !== CycleMemoryAccess.READ || this.cyclePageCrossed)
    ) {
      this.memory.read(this.cycleProvisionalAddress);
      if (
        this.cycleOperation === CycleOperation.XAS ||
        this.cycleOperation === CycleOperation.SAY
      ) {
        this.cycleIndexedStoreReadWasHeld = this.readWasHeldProbe?.() ?? false;
      }
      this.cyclePhase = 4;
      return false;
    }
    const dataPhase =
      indexed && (this.cycleMemoryAccess !== CycleMemoryAccess.READ || this.cyclePageCrossed)
        ? 4
        : 3;
    return this.tickCycleEffectiveAddress(dataPhase);
  }

  private tickCycleIndirectX(): boolean {
    if (this.cyclePhase === 1) {
      this.cycleBaseAddress = this.readCycleInstructionByte();
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      this.memory.read(this.cycleBaseAddress);
      this.cycleBaseAddress = (this.cycleBaseAddress + this.x) & CPU_BYTE_MAX;
      this.cyclePhase = 3;
      return false;
    }
    if (this.cyclePhase === 3) {
      this.cycleLow = this.memory.read(this.cycleBaseAddress);
      this.cyclePhase = 4;
      return false;
    }
    if (this.cyclePhase === 4) {
      const high = this.memory.read((this.cycleBaseAddress + 1) & CPU_BYTE_MAX);
      this.cycleAddress = this.cycleLow | (high << CPU_PAGE_SHIFT);
      this.cyclePhase = 5;
      return false;
    }
    return this.tickCycleEffectiveAddress(5);
  }

  private tickCycleIndirectY(): boolean {
    if (this.cyclePhase === 1) {
      this.cycleBaseAddress = this.readCycleInstructionByte();
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      this.cycleLow = this.memory.read(this.cycleBaseAddress);
      this.cyclePhase = 3;
      return false;
    }
    if (this.cyclePhase === 3) {
      const high = this.memory.read((this.cycleBaseAddress + 1) & CPU_BYTE_MAX);
      this.cycleBaseAddress = this.cycleLow | (high << CPU_PAGE_SHIFT);
      this.cycleAddress = word(this.cycleBaseAddress + this.y);
      this.cycleProvisionalAddress =
        (this.cycleBaseAddress & 0xff00) | (this.cycleAddress & CPU_PAGE_OFFSET_MASK);
      this.cyclePageCrossed = ((this.cycleBaseAddress ^ this.cycleAddress) & CPU_PAGE_SIZE) !== 0;
      this.cyclePhase = 4;
      return false;
    }
    if (
      this.cyclePhase === 4 &&
      (this.cycleMemoryAccess !== CycleMemoryAccess.READ || this.cyclePageCrossed)
    ) {
      this.memory.read(this.cycleProvisionalAddress);
      this.cyclePhase = 5;
      return false;
    }
    return this.tickCycleEffectiveAddress(
      this.cycleMemoryAccess !== CycleMemoryAccess.READ || this.cyclePageCrossed ? 5 : 4,
    );
  }

  private tickCycleEffectiveAddress(dataPhase: number): boolean {
    if (this.cyclePhase === dataPhase) {
      if (this.cycleMemoryAccess === CycleMemoryAccess.READ) {
        this.cycleData = this.memory.read(this.cycleAddress);
        this.applyCycleRead(this.cycleData);
        return this.finishCycleInstruction();
      }
      if (this.cycleMemoryAccess === CycleMemoryAccess.WRITE) {
        const packed = this.cycleStoreAddressAndValue();
        this.memory.write(packed >>> CPU_PAGE_SHIFT, packed & CPU_BYTE_MAX);
        return this.finishCycleInstruction();
      }
      this.cycleData = this.memory.read(this.cycleAddress);
      this.cyclePhase += 1;
      return false;
    }
    if (this.cyclePhase === dataPhase + 1) {
      this.memory.write(this.cycleAddress, this.cycleData);
      this.cyclePhase += 1;
      return false;
    }
    const transformed = this.prepareCycleReadModifyWrite(this.cycleData);
    this.memory.write(this.cycleAddress, transformed);
    this.completeCycleReadModifyWrite(transformed);
    return this.finishCycleInstruction();
  }

  /** 地址放高 16 位、数据放低八位，避免在写热路径分配元组。 */
  private cycleStoreAddressAndValue(): number {
    let value: number;
    switch (this.cycleOperation) {
      case CycleOperation.STA:
        value = this.a;
        break;
      case CycleOperation.STX:
        value = this.x;
        break;
      case CycleOperation.STY:
        value = this.y;
        break;
      case CycleOperation.AXS_STORE:
        value = this.a & this.x;
        break;
      case CycleOperation.TAS:
        this.sp = this.a & this.x;
        value = this.sp;
        break;
      case CycleOperation.AXA:
        value = this.a & this.x;
        break;
      case CycleOperation.XAS:
        value = this.x;
        break;
      case CycleOperation.SAY:
        value = this.y;
        break;
      default:
        throw new Error(`Operation ${this.cycleOperation} is not a store.`);
    }

    let writeAddress = this.cycleAddress;
    if (
      this.cycleOperation === CycleOperation.AXA ||
      this.cycleOperation === CycleOperation.TAS ||
      this.cycleOperation === CycleOperation.XAS ||
      this.cycleOperation === CycleOperation.SAY
    ) {
      const highByteMask = ((this.cycleBaseAddress >>> CPU_PAGE_SHIFT) + 1) & CPU_BYTE_MAX;
      const addressHighValue = value & highByteMask;
      const dataMaskDrops =
        this.cycleIndexedStoreReadWasHeld &&
        (this.cycleOperation === CycleOperation.XAS || this.cycleOperation === CycleOperation.SAY);
      if (!dataMaskDrops) value = addressHighValue;
      if (((this.cycleBaseAddress ^ this.cycleAddress) & CPU_PAGE_SIZE) !== 0) {
        writeAddress =
          (addressHighValue << CPU_PAGE_SHIFT) | (this.cycleAddress & CPU_PAGE_OFFSET_MASK);
      }
    }
    return (writeAddress << CPU_PAGE_SHIFT) | value;
  }

  private tickCycleSpecial(): boolean {
    switch (this.cycleOperation) {
      case CycleOperation.BRK:
        return this.tickCycleBreak();
      case CycleOperation.JAM:
        this.memory.read(this.pc);
        this.jammed = true;
        this.jamBusCycleIndex = 0;
        this.cyclePhase = 0;
        this.cyclesConsumed = this.cycleCurrentCycles;
        this.cycleCheckBreakpoints = false;
        return false;
      case CycleOperation.JSR:
        return this.tickCycleJumpSubroutine();
      case CycleOperation.JMP:
        return this.tickCycleJump();
      case CycleOperation.RTS:
        return this.tickCycleReturnSubroutine();
      case CycleOperation.RTI:
        return this.tickCycleReturnInterrupt();
      case CycleOperation.PHA:
      case CycleOperation.PHP:
        return this.tickCyclePushInstruction();
      case CycleOperation.PLA:
      case CycleOperation.PLP:
        return this.tickCyclePullInstruction();
      default:
        if (this.cycleAddressMode === CycleAddressMode.REL) return this.tickCycleBranch();
        this.memory.read(this.pc);
        this.applyCycleImplied();
        return this.finishCycleInstruction();
    }
  }

  private tickCycleBreak(): boolean {
    if (this.cyclePhase === 1) {
      this.memory.read(this.pc);
      this.pc = word(this.pc + 1);
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      this.push((this.pc >>> CPU_PAGE_SHIFT) & CPU_BYTE_MAX);
      this.cyclePhase = 3;
      return false;
    }
    if (this.cyclePhase === 3) {
      this.push(this.pc & CPU_BYTE_MAX);
      this.cyclePhase = 4;
      return false;
    }
    if (this.cyclePhase === 4) {
      this.push(this.p | CpuStatusFlag.Break | CpuStatusFlag.Unused);
      this.cyclePhase = 5;
      return false;
    }
    if (this.cyclePhase === 5) {
      this.cycleAddress = this.nmiTakeoverProbe?.()
        ? CPU_VECTOR.nonMaskableInterrupt
        : CPU_VECTOR.interruptRequest;
      this.cycleLow = this.memory.read(this.cycleAddress);
      this.cyclePhase = 6;
      return false;
    }
    const high = this.memory.read(word(this.cycleAddress + 1));
    this.pc = this.cycleLow | (high << CPU_PAGE_SHIFT);
    this.p |= CpuStatusFlag.InterruptDisable;
    return this.finishCycleInstruction();
  }

  private tickCycleJumpSubroutine(): boolean {
    if (this.cyclePhase === 1) {
      this.cycleLow = this.memory.read(this.pc);
      this.pc = word(this.pc + 1);
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      this.memory.readStack(this.sp);
      this.cyclePhase = 3;
      return false;
    }
    if (this.cyclePhase === 3) {
      this.push((this.pc >>> CPU_PAGE_SHIFT) & CPU_BYTE_MAX);
      this.cyclePhase = 4;
      return false;
    }
    if (this.cyclePhase === 4) {
      this.push(this.pc & CPU_BYTE_MAX);
      this.cyclePhase = 5;
      return false;
    }
    const high = this.memory.read(this.pc);
    this.pc = this.cycleLow | (high << CPU_PAGE_SHIFT);
    return this.finishCycleInstruction();
  }

  private tickCycleJump(): boolean {
    if (this.cyclePhase === 1) {
      this.cycleLow = this.readCycleInstructionByte();
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      const high = this.memory.read(this.pc);
      this.cycleAddress = this.cycleLow | (high << CPU_PAGE_SHIFT);
      if (this.cycleAddressMode === CycleAddressMode.ABS) {
        this.pc = this.cycleAddress;
        return this.finishCycleInstruction();
      }
      this.cyclePhase = 3;
      return false;
    }
    if (this.cyclePhase === 3) {
      this.cycleLow = this.memory.read(this.cycleAddress);
      this.cyclePhase = 4;
      return false;
    }
    const highAddress =
      (this.cycleAddress & CPU_PAGE_OFFSET_MASK) === CPU_PAGE_OFFSET_MASK
        ? this.cycleAddress & 0xff00
        : word(this.cycleAddress + 1);
    const high = this.memory.read(highAddress);
    this.pc = this.cycleLow | (high << CPU_PAGE_SHIFT);
    return this.finishCycleInstruction();
  }

  private tickCycleReturnSubroutine(): boolean {
    if (this.cyclePhase === 1) {
      this.memory.read(this.pc);
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      this.memory.readStack(this.sp);
      this.cyclePhase = 3;
      return false;
    }
    if (this.cyclePhase === 3) {
      this.sp = (this.sp + 1) & CPU_BYTE_MAX;
      this.cycleLow = this.memory.readStack(this.sp);
      this.cyclePhase = 4;
      return false;
    }
    if (this.cyclePhase === 4) {
      this.sp = (this.sp + 1) & CPU_BYTE_MAX;
      const high = this.memory.readStack(this.sp);
      this.cycleAddress = this.cycleLow | (high << CPU_PAGE_SHIFT);
      this.cyclePhase = 5;
      return false;
    }
    this.memory.read(this.cycleAddress);
    this.pc = word(this.cycleAddress + 1);
    return this.finishCycleInstruction();
  }

  private tickCycleReturnInterrupt(): boolean {
    if (this.cyclePhase === 1) {
      this.memory.read(this.pc);
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      this.memory.readStack(this.sp);
      this.cyclePhase = 3;
      return false;
    }
    if (this.cyclePhase === 3) {
      this.sp = (this.sp + 1) & CPU_BYTE_MAX;
      const value = this.memory.readStack(this.sp);
      this.p = (value & ~CpuStatusFlag.Break) | CpuStatusFlag.Unused;
      this.cyclePhase = 4;
      return false;
    }
    if (this.cyclePhase === 4) {
      this.sp = (this.sp + 1) & CPU_BYTE_MAX;
      this.cycleLow = this.memory.readStack(this.sp);
      this.cyclePhase = 5;
      return false;
    }
    this.sp = (this.sp + 1) & CPU_BYTE_MAX;
    const high = this.memory.readStack(this.sp);
    this.pc = this.cycleLow | (high << CPU_PAGE_SHIFT);
    return this.finishCycleInstruction();
  }

  private tickCyclePushInstruction(): boolean {
    if (this.cyclePhase === 1) {
      this.memory.read(this.pc);
      this.cyclePhase = 2;
      return false;
    }
    this.push(
      this.cycleOperation === CycleOperation.PHA
        ? this.a
        : this.p | CpuStatusFlag.Break | CpuStatusFlag.Unused,
    );
    return this.finishCycleInstruction();
  }

  private tickCyclePullInstruction(): boolean {
    if (this.cyclePhase === 1) {
      this.memory.read(this.pc);
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      this.memory.readStack(this.sp);
      this.cyclePhase = 3;
      return false;
    }
    this.sp = (this.sp + 1) & CPU_BYTE_MAX;
    const value = this.memory.readStack(this.sp);
    if (this.cycleOperation === CycleOperation.PLA) {
      this.a = value;
      this.setStatusFlags(value);
    } else {
      this.p = (value & ~CpuStatusFlag.Break) | CpuStatusFlag.Unused;
    }
    return this.finishCycleInstruction();
  }

  private tickCycleBranch(): boolean {
    if (this.cyclePhase === 1) {
      this.cycleData = this.readCycleInstructionByte();
      if (!this.isCycleBranchTaken()) return this.finishCycleInstruction();
      this.cycleBaseAddress = this.pc;
      const offset = this.cycleData < 0x80 ? this.cycleData : this.cycleData - CPU_PAGE_SIZE;
      this.cycleAddress = word(this.pc + offset);
      this.cyclePageCrossed = ((this.cycleBaseAddress ^ this.cycleAddress) & CPU_PAGE_SIZE) !== 0;
      this.cyclePhase = 2;
      return false;
    }
    if (this.cyclePhase === 2) {
      this.memory.read(this.cycleBaseAddress);
      if (!this.cyclePageCrossed) {
        this.interruptTiming.delayInterruptForTakenBranch();
        this.pc = this.cycleAddress;
        return this.finishCycleInstruction();
      }
      this.cyclePhase = 3;
      return false;
    }
    this.memory.read((this.cycleBaseAddress & 0xff00) | (this.cycleAddress & CPU_PAGE_OFFSET_MASK));
    this.pc = this.cycleAddress;
    return this.finishCycleInstruction();
  }

  private isCycleBranchTaken(): boolean {
    switch (this.cycleOperation) {
      case CycleOperation.BPL:
        return (this.p & CpuStatusFlag.Negative) === 0;
      case CycleOperation.BMI:
        return (this.p & CpuStatusFlag.Negative) !== 0;
      case CycleOperation.BVC:
        return (this.p & CpuStatusFlag.Overflow) === 0;
      case CycleOperation.BVS:
        return (this.p & CpuStatusFlag.Overflow) !== 0;
      case CycleOperation.BCC:
        return (this.p & CpuStatusFlag.Carry) === 0;
      case CycleOperation.BCS:
        return (this.p & CpuStatusFlag.Carry) !== 0;
      case CycleOperation.BNE:
        return (this.p & CpuStatusFlag.Zero) === 0;
      case CycleOperation.BEQ:
        return (this.p & CpuStatusFlag.Zero) !== 0;
      default:
        return false;
    }
  }

  private applyCycleImplied(): void {
    switch (this.cycleOperation) {
      case CycleOperation.NOP:
        break;
      case CycleOperation.ASL:
        this.a = this.asl(this.a);
        break;
      case CycleOperation.ROL:
        this.a = this.rol(this.a);
        break;
      case CycleOperation.LSR:
        this.a = this.lsr(this.a);
        break;
      case CycleOperation.ROR:
        this.a = this.ror(this.a);
        break;
      case CycleOperation.CLC:
        this.p &= ~CpuStatusFlag.Carry;
        break;
      case CycleOperation.SEC:
        this.p |= CpuStatusFlag.Carry;
        break;
      case CycleOperation.CLI:
        this.p &= ~CpuStatusFlag.InterruptDisable;
        break;
      case CycleOperation.SEI:
        this.p |= CpuStatusFlag.InterruptDisable;
        break;
      case CycleOperation.CLV:
        this.p &= ~CpuStatusFlag.Overflow;
        break;
      case CycleOperation.CLD:
        this.p &= ~CpuStatusFlag.Decimal;
        break;
      case CycleOperation.SED:
        this.p |= CpuStatusFlag.Decimal;
        break;
      case CycleOperation.DEY:
        this.y = (this.y - 1) & CPU_BYTE_MAX;
        this.setStatusFlags(this.y);
        break;
      case CycleOperation.INY:
        this.y = (this.y + 1) & CPU_BYTE_MAX;
        this.setStatusFlags(this.y);
        break;
      case CycleOperation.DEX:
        this.x = (this.x - 1) & CPU_BYTE_MAX;
        this.setStatusFlags(this.x);
        break;
      case CycleOperation.INX:
        this.x = (this.x + 1) & CPU_BYTE_MAX;
        this.setStatusFlags(this.x);
        break;
      case CycleOperation.TXA:
        this.a = this.x;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.TYA:
        this.a = this.y;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.TAY:
        this.y = this.a;
        this.setStatusFlags(this.y);
        break;
      case CycleOperation.TAX:
        this.x = this.a;
        this.setStatusFlags(this.x);
        break;
      case CycleOperation.TXS:
        this.sp = this.x;
        break;
      case CycleOperation.TSX:
        this.x = this.sp;
        this.setStatusFlags(this.x);
        break;
      default:
        throw new Error(`Unsupported implied operation ${this.cycleOperation}.`);
    }
  }

  private applyCycleRead(value: number): void {
    switch (this.cycleOperation) {
      case CycleOperation.NOP:
        break;
      case CycleOperation.ORA:
        this.a |= value;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.AND:
        this.a &= value;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.EOR:
        this.a ^= value;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.ADC:
        this.operateAdd(value);
        break;
      case CycleOperation.SBC:
        this.operateSub(value);
        break;
      case CycleOperation.BIT:
        this.p &= ~(CpuStatusFlag.Zero | CpuStatusFlag.Overflow | CpuStatusFlag.Negative);
        this.p |= value & (CpuStatusFlag.Overflow | CpuStatusFlag.Negative);
        if ((this.a & value) === 0) this.p |= CpuStatusFlag.Zero;
        break;
      case CycleOperation.LDA:
        this.a = value;
        this.setStatusFlags(value);
        break;
      case CycleOperation.LDX:
        this.x = value;
        this.setStatusFlags(value);
        break;
      case CycleOperation.LDY:
        this.y = value;
        this.setStatusFlags(value);
        break;
      case CycleOperation.LAX:
        this.a = value;
        this.x = value;
        this.setStatusFlags(value);
        break;
      case CycleOperation.LAS:
        this.a = value & this.sp;
        this.x = this.a;
        this.sp = this.a;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.CMP:
        this.operateCmp(this.a, value);
        break;
      case CycleOperation.CPX:
        this.operateCmp(this.x, value);
        break;
      case CycleOperation.CPY:
        this.operateCmp(this.y, value);
        break;
      case CycleOperation.ANC:
        this.a &= value;
        this.setStatusFlags(this.a);
        this.p &= ~CpuStatusFlag.Carry;
        if ((this.p & CpuStatusFlag.Negative) !== 0) this.p |= CpuStatusFlag.Carry;
        break;
      case CycleOperation.ALR:
        this.a &= value;
        this.setStatusFlags(this.a);
        this.a = this.lsr(this.a);
        break;
      case CycleOperation.ARR:
        this.operateArr(value);
        break;
      case CycleOperation.XAA:
        this.a = (this.a | NMOS_UNSTABLE_DATA_MASK) & this.x & value;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.OAL:
        this.a = (this.a | NMOS_UNSTABLE_DATA_MASK) & value;
        this.x = this.a;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.SAX_SUBTRACT: {
        const difference = (this.a & this.x) - value;
        this.p &= ~CpuStatusFlag.Carry;
        if (difference >= 0) this.p |= CpuStatusFlag.Carry;
        this.x = difference & CPU_BYTE_MAX;
        this.setStatusFlags(this.x);
        break;
      }
      default:
        throw new Error(`Unsupported read operation ${this.cycleOperation}.`);
    }
  }

  private prepareCycleReadModifyWrite(value: number): number {
    switch (this.cycleOperation) {
      case CycleOperation.ASL:
      case CycleOperation.ASO:
        return this.asl(value);
      case CycleOperation.ROL:
      case CycleOperation.RLA:
        return this.rol(value);
      case CycleOperation.LSR:
      case CycleOperation.LSE:
        return this.lsr(value);
      case CycleOperation.ROR:
      case CycleOperation.RRA:
        return this.ror(value);
      case CycleOperation.DEC:
        return this.decrement(value);
      case CycleOperation.INC:
      case CycleOperation.INS:
        return this.increment(value);
      case CycleOperation.DCM:
        return (value - 1) & CPU_BYTE_MAX;
      default:
        throw new Error(`Unsupported read-modify-write operation ${this.cycleOperation}.`);
    }
  }

  private completeCycleReadModifyWrite(value: number): void {
    switch (this.cycleOperation) {
      case CycleOperation.ASO:
        this.a |= value;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.RLA:
        this.a &= value;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.LSE:
        this.a ^= value;
        this.setStatusFlags(this.a);
        break;
      case CycleOperation.RRA:
        this.operateAdd(value);
        break;
      case CycleOperation.DCM:
        this.operateCmp(this.a, value);
        break;
      case CycleOperation.INS:
        this.operateSub(value);
        break;
    }
  }

  // ------------------------------------------------------------------------
  // 正式操作码处理器
  // ------------------------------------------------------------------------

  opBRK() {
    this.dummyRead(this.pc);
    this.pc = word(this.pc + 1);
    this.pushWord(this.pc);
    this.push(this.p | CpuStatusFlag.Break | CpuStatusFlag.Unused);
    this.pc = this.readBrkOrIrqVector();
    this.p |= CpuStatusFlag.InterruptDisable;
  }

  opHLT() {
    this.dummyRead(this.pc);
    this.jammed = true;
    this.jamBusCycleIndex = 0;
  }

  opNOP() {
    this.dummyRead(this.pc);
  }

  opBCC() {
    this.branch(CpuStatusFlag.Carry, false);
  }

  opBCS() {
    this.branch(CpuStatusFlag.Carry, true);
  }

  opBNE() {
    this.branch(CpuStatusFlag.Zero, false);
  }

  opBEQ() {
    this.branch(CpuStatusFlag.Zero, true);
  }

  opBVC() {
    this.branch(CpuStatusFlag.Overflow, false);
  }

  opBVS() {
    this.branch(CpuStatusFlag.Overflow, true);
  }

  opBPL() {
    this.branch(CpuStatusFlag.Negative, false);
  }

  opBMI() {
    this.branch(CpuStatusFlag.Negative, true);
  }

  opSEC() {
    this.dummyRead(this.pc);
    this.p |= CpuStatusFlag.Carry;
  }

  opSEI() {
    this.dummyRead(this.pc);
    this.p |= CpuStatusFlag.InterruptDisable;
  }

  opSED() {
    this.dummyRead(this.pc);
    this.p |= CpuStatusFlag.Decimal;
  }

  opCLC() {
    this.dummyRead(this.pc);
    this.p &= ~CpuStatusFlag.Carry;
  }

  opCLV() {
    this.dummyRead(this.pc);
    this.p &= ~CpuStatusFlag.Overflow;
  }

  opCLD() {
    this.dummyRead(this.pc);
    this.p &= ~CpuStatusFlag.Decimal;
  }

  opCLI() {
    this.dummyRead(this.pc);
    this.p &= ~CpuStatusFlag.InterruptDisable;
  }

  opJSR(addr: AddressingMode) {
    void addr;
    const targetLow = this.memory.read(this.pc);
    this.pc = word(this.pc + 1);
    this.memory.readStack(this.sp);
    this.pushWord(this.pc);
    const targetHigh = this.memory.read(this.pc);
    this.pc = targetLow | (targetHigh << 8);
  }

  opJMP(addr: AddressingMode) {
    this.pc = this.resolveAddress(addr, CpuMemoryAccess.Read);
  }

  opRTS() {
    this.dummyRead(this.pc);
    this.memory.readStack(this.sp);
    const returnAddress = this.popWord();
    this.dummyRead(returnAddress);
    this.pc = word(returnAddress + 1);
  }

  opRTI() {
    this.dummyRead(this.pc);
    this.memory.readStack(this.sp);
    this.p = (this.pop() & ~CpuStatusFlag.Break) | CpuStatusFlag.Unused;
    this.pc = this.popWord();
  }

  opAND(addr: AddressingMode) {
    this.a &= this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
    this.setStatusFlags(this.a);
  }

  opORA(addr: AddressingMode) {
    this.a |= this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
    this.setStatusFlags(this.a);
  }

  opBIT(addr: AddressingMode) {
    const i = this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
    this.p &= ~(CpuStatusFlag.Zero | CpuStatusFlag.Overflow | CpuStatusFlag.Negative);
    this.p |= i & (CpuStatusFlag.Overflow | CpuStatusFlag.Negative);
    if ((this.a & i) === 0) this.p |= CpuStatusFlag.Zero;
  }

  opADC(addr: AddressingMode) {
    this.operateAdd(this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read)));
  }

  opSBC(addr: AddressingMode) {
    this.operateSub(this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read)));
  }

  opROL(addr: AddressingMode) {
    const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
    const original = this.memory.read(address);
    this.memory.write(address, original);
    this.memory.write(address, this.rol(original));
  }

  opROL_A() {
    this.dummyRead(this.pc);
    this.a = this.rol(this.a);
  }

  opROR(addr: AddressingMode) {
    const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
    const original = this.memory.read(address);
    this.memory.write(address, original);
    this.memory.write(address, this.ror(original));
  }

  opROR_A() {
    this.dummyRead(this.pc);
    this.a = this.ror(this.a);
  }

  opASL(addr: AddressingMode) {
    const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
    const original = this.memory.read(address);
    this.memory.write(address, original);
    this.memory.write(address, this.asl(original));
  }

  opASL_A() {
    this.dummyRead(this.pc);
    this.a = this.asl(this.a);
  }

  opLSR(addr: AddressingMode) {
    const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
    const original = this.memory.read(address);
    this.memory.write(address, original);
    this.memory.write(address, this.lsr(original));
  }

  opLSR_A() {
    this.dummyRead(this.pc);
    this.a = this.lsr(this.a);
  }

  opPLA() {
    this.dummyRead(this.pc);
    this.memory.readStack(this.sp);
    this.a = this.pop();
    this.setStatusFlags(this.a);
  }

  opPLP() {
    this.dummyRead(this.pc);
    this.memory.readStack(this.sp);
    this.p = (this.pop() & ~CpuStatusFlag.Break) | CpuStatusFlag.Unused;
  }

  opPHA() {
    this.dummyRead(this.pc);
    this.push(this.a);
  }

  opPHP() {
    this.dummyRead(this.pc);
    this.push(this.p | CpuStatusFlag.Break | CpuStatusFlag.Unused);
  }

  opEOR(addr: AddressingMode) {
    this.a ^= this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
    this.setStatusFlags(this.a);
  }

  opTAX() {
    this.dummyRead(this.pc);
    this.x = this.a;
    this.setStatusFlags(this.x);
  }

  opTAY() {
    this.dummyRead(this.pc);
    this.y = this.a;
    this.setStatusFlags(this.y);
  }

  opTXA() {
    this.dummyRead(this.pc);
    this.a = this.x;
    this.setStatusFlags(this.a);
  }

  opTYA() {
    this.dummyRead(this.pc);
    this.a = this.y;
    this.setStatusFlags(this.a);
  }

  opTSX() {
    this.dummyRead(this.pc);
    this.x = this.sp & 0xff;
    this.setStatusFlags(this.x);
  }

  opTXS() {
    this.dummyRead(this.pc);
    this.sp = this.x & 0xff;
  }

  opLDA(addr: AddressingMode) {
    const address = this.resolveAddress(addr, CpuMemoryAccess.Read);
    const newValue = this.memory.read(address);
    this.a = newValue;
    this.setStatusFlags(this.a);
  }

  opLDX(addr: AddressingMode) {
    this.x = this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
    this.setStatusFlags(this.x);
  }

  opLDY(addr: AddressingMode) {
    this.y = this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
    this.setStatusFlags(this.y);
  }

  opSTA(addr: AddressingMode) {
    this.memory.write(this.resolveAddress(addr, CpuMemoryAccess.Write), this.a);
  }

  opSTX(addr: AddressingMode) {
    this.memory.write(this.resolveAddress(addr, CpuMemoryAccess.Write), this.x);
  }

  opSTY(addr: AddressingMode) {
    this.memory.write(this.resolveAddress(addr, CpuMemoryAccess.Write), this.y);
  }

  opCMP(addr: AddressingMode) {
    const ad = this.resolveAddress(addr, CpuMemoryAccess.Read);
    this.operateCmp(this.a, this.memory.read(ad));
  }

  opCPX(addr: AddressingMode) {
    this.operateCmp(this.x, this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read)));
  }

  opCPY(addr: AddressingMode) {
    this.operateCmp(this.y, this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read)));
  }

  opDEC(addr: AddressingMode) {
    const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
    const original = this.memory.read(address);
    this.memory.write(address, original);
    this.memory.write(address, this.decrement(original));
  }

  opDEX() {
    this.dummyRead(this.pc);
    this.x--;
    this.x &= 0xff;
    this.setStatusFlags(this.x);
  }

  opDEY() {
    this.dummyRead(this.pc);
    this.y--;
    this.y &= 0xff;
    this.setStatusFlags(this.y);
  }

  opINC(addr: AddressingMode) {
    const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
    const original = this.memory.read(address);
    this.memory.write(address, original);
    this.memory.write(address, this.increment(original));
  }

  opINX() {
    this.dummyRead(this.pc);
    this.x++;
    this.x &= 0xff;
    this.setStatusFlags(this.x);
  }

  opINY() {
    this.dummyRead(this.pc);
    this.y++;
    this.y &= 0xff;
    this.setStatusFlags(this.y);
  }

  // ------------------------------------------------------------------------
  // NMOS 6502 未公开操作码处理器
  // ------------------------------------------------------------------------

  opASO(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
      const original = this.memory.read(address);
      this.memory.write(address, original);
      const value = this.asl(original);
      this.memory.write(address, value);
      this.a |= value;
      this.setStatusFlags(this.a);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opUndocumentedNOP(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opANC() {
    if (this.useUndocumentedOpcodes) {
      this.a &= this.readAtomicInstructionByte();
      this.setStatusFlags(this.a);
      this.p &= ~CpuStatusFlag.Carry;
      if ((this.p & CpuStatusFlag.Negative) !== 0) this.p |= CpuStatusFlag.Carry;
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opRLA(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
      const original = this.memory.read(address);
      this.memory.write(address, original);
      const value = this.rol(original);
      this.memory.write(address, value);
      this.a &= value;
      this.setStatusFlags(this.a);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opLSE(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
      const original = this.memory.read(address);
      this.memory.write(address, original);
      const value = this.lsr(original);
      this.memory.write(address, value);
      this.a ^= value;
      this.setStatusFlags(this.a);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opALR() {
    if (this.useUndocumentedOpcodes) {
      this.a &= this.readAtomicInstructionByte();
      this.setStatusFlags(this.a); // [CW] needed? unsure..
      this.a = this.lsr(this.a);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opRRA(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
      const original = this.memory.read(address);
      this.memory.write(address, original);
      const value = this.ror(original);
      this.memory.write(address, value);
      this.operateAdd(value); // [CW] was: this.operateAdd(address). bug?
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opARR() {
    if (this.useUndocumentedOpcodes) {
      this.operateArr(this.readAtomicInstructionByte());
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opAXS(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      this.memory.write(this.resolveAddress(addr, CpuMemoryAccess.Write), this.a & this.x);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opAXA(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      this.writeUnstableIndexedStore(addr, this.y, this.a & this.x);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opTAS(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      this.sp = this.x & this.a;
      this.writeUnstableIndexedStore(addr, this.y, this.sp);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opXAA() {
    // XAA 会把累加器经由 NMOS 内部数据掩码后再与 X、立即数相与。
    if (this.useUndocumentedOpcodes) {
      const immediate = this.readAtomicInstructionByte();
      this.a = (this.a | NMOS_UNSTABLE_DATA_MASK) & this.x & immediate;
      this.setStatusFlags(this.a);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opXAS(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      this.writeUnstableIndexedStore(
        addr,
        this.y,
        this.x,
        CpuUnstableStoreDataMaskMode.DropAfterHeldRead,
      );
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opSAY(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      this.writeUnstableIndexedStore(
        addr,
        this.x,
        this.y,
        CpuUnstableStoreDataMaskMode.DropAfterHeldRead,
      );
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opLAX(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      this.a = this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
      this.x = this.a;
      this.setStatusFlags(this.a);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opLAS(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      this.a = this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read)) & this.sp;
      this.x = this.a;
      this.sp = this.a;
      this.setStatusFlags(this.a);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opOAL(addr: AddressingMode) {
    // OAL 与 XAA 共享相同的 NMOS 内部数据掩码，但会同时写回 A 和 X。
    if (this.useUndocumentedOpcodes) {
      this.a |= NMOS_UNSTABLE_DATA_MASK;
      this.a &= this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
      this.x = this.a;
      this.setStatusFlags(this.a);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opDCM(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
      const original = this.memory.read(address);
      this.memory.write(address, original);
      const value = (original - 1) & 0xff;
      this.memory.write(address, value);
      this.operateCmp(this.a, value);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opSAX(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      const difference =
        (this.a & this.x) - this.memory.read(this.resolveAddress(addr, CpuMemoryAccess.Read));
      this.p &= ~CpuStatusFlag.Carry;
      if (difference >= 0) this.p |= CpuStatusFlag.Carry;
      this.x = difference & CPU_BYTE_MAX;
      this.setStatusFlags(this.x);
    } else {
      this.usedUndocumentedOpcode();
    }
  }

  opINS(addr: AddressingMode) {
    if (this.useUndocumentedOpcodes) {
      const address = this.resolveAddress(addr, CpuMemoryAccess.ReadModifyWrite);
      const original = this.memory.read(address);
      this.memory.write(address, original);
      const value = this.increment(original);
      this.memory.write(address, value);
      this.operateSub(value);
    } else {
      this.usedUndocumentedOpcode();
    }
  }
  // ------------------------------------------------------------------------
  // 寻址方式
  // ------------------------------------------------------------------------

  /**
   * 立即寻址 `#$00`。
   *
   * @returns 操作数字节所在地址；调用方随后通过总线读取该字节。
   */
  byImmediate() {
    const address = this.pc;
    this.pc = word(this.pc + 1);
    return address;
  }
  /**
   * 零页寻址 `$aa`。
   *
   * @returns 八位零页有效地址。
   */
  byZeroPage() {
    return this.readAtomicInstructionByte();
  }
  /**
   * X 变址零页寻址 `$aa,X`。
   *
   * @returns 在零页内回绕后的八位有效地址。
   */
  byZeroPageX() {
    const baseAddress = this.readAtomicInstructionByte();
    this.dummyRead(baseAddress);
    return (baseAddress + this.x) & 0xff;
  }
  /**
   * Y 变址零页寻址 `$aa,Y`。
   *
   * @returns 在零页内回绕后的八位有效地址。
   */
  byZeroPageY() {
    const baseAddress = this.readAtomicInstructionByte();
    this.dummyRead(baseAddress);
    return (baseAddress + this.y) & 0xff;
  }
  /**
   * 绝对寻址 `$aaaa`。
   *
   * @returns 指令流中低字节在前的 16 位有效地址。
   */
  byAbsolute() {
    const address = this.memory.readWord(this.pc);
    this.pc = word(this.pc + 2);
    return address;
  }
  /**
   * X 变址绝对寻址 `$aaaa,X`。
   *
   * @returns 加上 X 后的 16 位有效地址；跨页和写周期会保留虚读。
   */
  byAbsoluteX() {
    const baseAddress = this.memory.readWord(this.pc);
    const indexedAddress = word(baseAddress + this.x);
    const pageCrossed = ((indexedAddress ^ baseAddress) & 0x100) !== 0;
    if (this.memoryAccess !== CpuMemoryAccess.Read || pageCrossed) {
      this.dummyRead((baseAddress & 0xff00) | (indexedAddress & 0x00ff));
    }
    if (this.memoryAccess === CpuMemoryAccess.Read && pageCrossed) {
      this.cyclesConsumed++;
    }
    this.pc = word(this.pc + 2);
    return indexedAddress;
  }
  /**
   * Y 变址绝对寻址 `$aaaa,Y`。
   *
   * @returns 加上 Y 后的 16 位有效地址；跨页和写周期会保留虚读。
   */
  byAbsoluteY() {
    const baseAddress = this.memory.readWord(this.pc);
    const indexedAddress = word(baseAddress + this.y);
    const pageCrossed = ((indexedAddress ^ baseAddress) & 0x100) !== 0;
    if (this.memoryAccess !== CpuMemoryAccess.Read || pageCrossed) {
      this.dummyRead((baseAddress & 0xff00) | (indexedAddress & 0x00ff));
    }
    if (this.memoryAccess === CpuMemoryAccess.Read && pageCrossed) {
      this.cyclesConsumed++;
    }
    this.pc = word(this.pc + 2);
    return indexedAddress;
  }
  /**
   * JMP 间接寻址 `($aaaa)`。
   *
   * @returns 指针指向的 16 位地址；指针低字节为 `$FF` 时复刻 NMOS 同页回绕缺陷。
   */
  byIndirect() {
    const i = this.memory.readWord(this.pc);
    this.pc = word(this.pc + 2);
    if ((i & 0x00ff) == 0xff) {
      return (this.memory.read(i & 0xff00) << 8) | this.memory.read(i);
    } else {
      return this.memory.readWord(i);
    }
  }
  /**
   * X 变址零页间接寻址 `($aa,X)`。
   *
   * @returns 零页指针指向的 16 位有效地址。
   */
  byIndirectX() {
    const basePointer = this.readAtomicInstructionByte();
    this.dummyRead(basePointer);
    const pointer = (basePointer + this.x) & 0xff;
    return this.readZeroPageWord(pointer);
  }
  /**
   * 零页间接 Y 变址寻址 `($aa),Y`。
   *
   * @returns 指针基址加 Y 后的有效地址；跨页和写周期会保留虚读。
   */
  byIndirectY() {
    const baseAddress = this.readZeroPageWord(this.readAtomicInstructionByte());
    const indexedAddress = word(baseAddress + this.y);
    const pageCrossed = ((indexedAddress ^ baseAddress) & 0x100) !== 0;
    if (this.memoryAccess !== CpuMemoryAccess.Read || pageCrossed) {
      this.dummyRead((baseAddress & 0xff00) | (indexedAddress & 0x00ff));
    }
    if (this.memoryAccess === CpuMemoryAccess.Read && pageCrossed) {
      this.cyclesConsumed++;
    }
    return indexedAddress;
  }
  // ------------------------------------------------------------------------
  // 运算与状态辅助方法
  // ------------------------------------------------------------------------

  /** 按八位结果更新零标志和负标志。 */
  setStatusFlags(value: number) {
    this.p &= ~(CpuStatusFlag.Zero | CpuStatusFlag.Negative);
    this.p |= this.znTable[value] ?? 0;
  }

  /** 执行八位算术左移，并更新 C、Z、N。 */
  asl(i: number) {
    this.p &= ~(CpuStatusFlag.Carry | CpuStatusFlag.Zero | CpuStatusFlag.Negative);
    this.p |= i >> 7;
    i <<= 1;
    i &= 0xff;
    this.p |= this.znTable[i] ?? 0;
    return i;
  }

  /** 执行八位逻辑右移，并更新 C、Z、N。 */
  lsr(i: number) {
    this.p &= ~(CpuStatusFlag.Carry | CpuStatusFlag.Zero | CpuStatusFlag.Negative);
    this.p |= i & CpuStatusFlag.Carry;
    i >>= 1;
    this.p |= this.znTable[i] ?? 0;
    return i;
  }

  /** 通过进位标志执行八位循环左移。 */
  rol(i: number) {
    i <<= 1;
    i |= this.p & CpuStatusFlag.Carry;
    this.p &= ~(CpuStatusFlag.Carry | CpuStatusFlag.Zero | CpuStatusFlag.Negative);
    this.p |= i >> 8;
    i &= 0xff;
    this.p |= this.znTable[i] ?? 0;
    return i;
  }

  /** 通过进位标志执行八位循环右移。 */
  ror(i: number) {
    const j = this.p & CpuStatusFlag.Carry;
    this.p &= ~(CpuStatusFlag.Carry | CpuStatusFlag.Zero | CpuStatusFlag.Negative);
    this.p |= i & CpuStatusFlag.Carry;
    i >>= 1;
    i |= j << 7;
    this.p |= this.znTable[i] ?? 0;
    return i;
  }
  /** 执行八位递增并更新 Z、N。 */
  increment(i: number) {
    i = (i + 1) & 0xff;
    this.setStatusFlags(i);
    return i;
  }
  /** 执行八位递减并更新 Z、N。 */
  decrement(i: number) {
    i = (i - 1) & 0xff;
    this.setStatusFlags(i);
    return i;
  }

  /** 执行 ADC，并复现 NMOS 十进制校正对无效 BCD 半字节的确定性结果。 */
  operateAdd(i: number) {
    const accumulator = this.a;
    // C 输入在 ADC 中表示额外加一。
    const k = this.p & CpuStatusFlag.Carry;
    // 先保存未截断的二进制和，供 C 与 V 判断。
    const j = this.a + i + k;
    // 结果标志必须从本次运算重新产生。
    this.p &= ~(
      CpuStatusFlag.Carry |
      CpuStatusFlag.Zero |
      CpuStatusFlag.Overflow |
      CpuStatusFlag.Negative
    );
    const binaryResult = j & 0xff;
    if ((this.p & CpuStatusFlag.Decimal) !== 0) {
      // NMOS 电路先独立校正低半字节，再把十位进位送入高半字节；不能先转换成十进制整数，
      // 否则 A-F 这些无效 BCD 数字会得到不同结果。
      let lowNibbleSum = (accumulator & CPU_LOW_NIBBLE_MASK) + (i & CPU_LOW_NIBBLE_MASK) + k;
      if (lowNibbleSum >= BCD_DIGIT_BASE) {
        lowNibbleSum =
          ((lowNibbleSum + BCD_LOW_DIGIT_ADJUSTMENT) & CPU_LOW_NIBBLE_MASK) + CPU_NIBBLE_CARRY;
      }

      let decimalIntermediate =
        (accumulator & CPU_HIGH_NIBBLE_MASK) + (i & CPU_HIGH_NIBBLE_MASK) + lowNibbleSum;
      if (binaryResult === 0) this.p |= CpuStatusFlag.Zero;
      if ((decimalIntermediate & CpuStatusFlag.Negative) !== 0) this.p |= CpuStatusFlag.Negative;
      if (
        (~(accumulator ^ i) & (accumulator ^ decimalIntermediate) & CpuStatusFlag.Negative) !==
        0
      ) {
        this.p |= CpuStatusFlag.Overflow;
      }
      if (decimalIntermediate >= BCD_HIGH_DIGIT_THRESHOLD) {
        decimalIntermediate += BCD_HIGH_DIGIT_ADJUSTMENT;
      }
      if (decimalIntermediate > CPU_BYTE_MAX) this.p |= CpuStatusFlag.Carry;
      this.a = decimalIntermediate & CPU_BYTE_MAX;
      return;
    }

    // 同号操作数得到异号结果时设置二进制溢出。
    if ((~(accumulator ^ i) & (accumulator ^ j) & CpuStatusFlag.Negative) !== 0) {
      this.p |= CpuStatusFlag.Overflow;
    }
    if (j > 0xff) this.p |= CpuStatusFlag.Carry;
    this.a = binaryResult;
    this.p |= this.znTable[this.a] ?? 0;
  }

  /** 执行 SBC；C=1 表示没有借位，十进制修正不改变 NMOS 的二进制标志来源。 */
  operateSub(i: number) {
    const accumulator = this.a;
    // SBC 把清零的 C 解释为需要额外借一。
    const k = (this.p & CpuStatusFlag.Carry) === 0 ? 1 : 0;
    // 未截断差值用于判断借位和二进制溢出。
    const j = this.a - i - k;
    // 结果标志必须从本次运算重新产生。
    this.p &= ~(
      CpuStatusFlag.Carry |
      CpuStatusFlag.Zero |
      CpuStatusFlag.Overflow |
      CpuStatusFlag.Negative
    );
    // 异号操作数得到与累加器异号的结果时设置溢出。
    if (((accumulator ^ j) & (accumulator ^ i) & CpuStatusFlag.Negative) !== 0) {
      this.p |= CpuStatusFlag.Overflow;
    }
    const binaryResult = j & 0xff;
    if (j >= 0) this.p |= CpuStatusFlag.Carry;

    if ((this.p & CpuStatusFlag.Decimal) !== 0) {
      let lowNibbleDifference = (accumulator & CPU_LOW_NIBBLE_MASK) - (i & CPU_LOW_NIBBLE_MASK) - k;
      let highNibbleDifference =
        (accumulator >> CPU_NIBBLE_BIT_COUNT) - (i >> CPU_NIBBLE_BIT_COUNT);
      if (lowNibbleDifference < 0) {
        lowNibbleDifference -= BCD_LOW_DIGIT_ADJUSTMENT;
        highNibbleDifference -= 1;
      }
      if (highNibbleDifference < 0) {
        highNibbleDifference -= BCD_LOW_DIGIT_ADJUSTMENT;
      }
      this.a =
        ((highNibbleDifference << CPU_NIBBLE_BIT_COUNT) & CPU_HIGH_NIBBLE_MASK) |
        (lowNibbleDifference & CPU_LOW_NIBBLE_MASK);
      this.p |= this.znTable[binaryResult] ?? 0;
      return;
    }

    this.a = binaryResult;
    this.p |= this.znTable[this.a] ?? 0;
  }

  /** 执行未公开 ARR 的 AND、ROR 与 NMOS 十进制半字节校正。 */
  private operateArr(immediate: number): void {
    const andResult = this.a & immediate;
    const carryIn = this.p & CpuStatusFlag.Carry;
    let rotatedResult = (andResult | (carryIn << 8)) >>> 1;
    this.p &= ~(
      CpuStatusFlag.Carry |
      CpuStatusFlag.Zero |
      CpuStatusFlag.Overflow |
      CpuStatusFlag.Negative
    );

    // N 来自旧 C；V 表示旋转前后第 6 位是否改变。
    if (carryIn !== 0) this.p |= CpuStatusFlag.Negative;
    if (rotatedResult === 0) this.p |= CpuStatusFlag.Zero;
    if (((rotatedResult ^ andResult) & CpuStatusFlag.Overflow) !== 0) {
      this.p |= CpuStatusFlag.Overflow;
    }

    if ((this.p & CpuStatusFlag.Decimal) !== 0) {
      if (
        (andResult & CPU_LOW_NIBBLE_MASK) + (andResult & CpuStatusFlag.Carry) >
        ARR_LOW_DIGIT_THRESHOLD
      ) {
        rotatedResult =
          (rotatedResult & CPU_HIGH_NIBBLE_MASK) |
          ((rotatedResult + BCD_LOW_DIGIT_ADJUSTMENT) & CPU_LOW_NIBBLE_MASK);
      }
      if (
        (andResult & CPU_HIGH_NIBBLE_MASK) + (andResult & CPU_NIBBLE_CARRY) >
        ARR_HIGH_DIGIT_THRESHOLD
      ) {
        rotatedResult =
          (rotatedResult & CPU_LOW_NIBBLE_MASK) |
          ((rotatedResult + BCD_HIGH_DIGIT_ADJUSTMENT) & CPU_HIGH_NIBBLE_MASK);
        this.p |= CpuStatusFlag.Carry;
      }
    } else if ((rotatedResult & ARR_CARRY_SOURCE_MASK) !== 0) {
      this.p |= CpuStatusFlag.Carry;
    }
    this.a = rotatedResult & CPU_BYTE_MAX;
  }

  /** 用不写回的八位减法实现 CMP/CPX/CPY 标志。 */
  operateCmp(i: number, j: number) {
    const k = i - j;
    this.p &= ~(CpuStatusFlag.Carry | CpuStatusFlag.Zero | CpuStatusFlag.Negative);
    if (k >= 0) this.p |= CpuStatusFlag.Carry;
    this.p |= this.znTable[k & 0xff] ?? 0;
  }

  /** 执行相对分支，并保留已采用分支及跨页时的虚读周期。 */
  branch(flagNum: number, flagVal: boolean) {
    let offset = this.readAtomicInstructionByte();
    if (((this.p & flagNum) != 0) == flagVal) {
      if (offset & 0x80) {
        offset = -(~offset & 0xff) - 1;
      }
      const branchOrigin = this.pc;
      const branchTarget = word(branchOrigin + offset);
      const pageCrossed = ((branchOrigin ^ branchTarget) & 0x100) !== 0;
      this.dummyRead(branchOrigin);
      if (pageCrossed) {
        this.dummyRead((branchOrigin & 0xff00) | (branchTarget & 0x00ff));
        this.cyclesConsumed++;
      } else {
        this.interruptTiming.delayInterruptForTakenBranch();
      }
      this.pc = branchTarget;
      this.cyclesConsumed += 1;
    }
  }
  /**
   * 处理被配置为禁用的未公开操作码。
   *
   * [CW] 不能假装“跳过”并继续，因为操作数字节数和总线副作用并不统一；这里明确停机。
   */
  usedUndocumentedOpcode() {
    throw new Error('Undocumented 6502 opcode execution is disabled.');
  }

  private readAtomicInstructionByte(): number {
    const address = this.pc;
    this.pc = word(this.pc + 1);
    return this.memory.read(address);
  }

  private readZeroPageWord(address: number): number {
    const lowAddress = address & 0xff;
    const highAddress = (lowAddress + 1) & 0xff;
    return this.memory.read(lowAddress) | (this.memory.read(highAddress) << 8);
  }

  private resolveAddress(addressingMode: AddressingMode, access: CpuMemoryAccess): number {
    const previousAccess = this.memoryAccess;
    this.memoryAccess = access;
    try {
      return addressingMode();
    } finally {
      this.memoryAccess = previousAccess;
    }
  }

  /**
   * 执行 AHX/TAS/SHX/SHY 共用的 NMOS 不稳定变址写周期。
   *
   * 常态写入值会与“变址前基址高字节 + 1”相与；发生跨页时，该掩码值还会
   * 取代地址总线高字节。SHX/SHY 的第四周期读被 RDY 延长时仅数据掩码脱落，
   * 地址高字节仍保持相同规则。显式分离两条数据路径可避免固定延迟或地址特判。
   */
  private writeUnstableIndexedStore(
    addressingMode: AddressingMode,
    indexRegister: number,
    sourceValue: number,
    dataMaskMode = CpuUnstableStoreDataMaskMode.Always,
  ): void {
    const indexedAddress = this.resolveAddress(addressingMode, CpuMemoryAccess.Write);
    const readWasHeld =
      dataMaskMode === CpuUnstableStoreDataMaskMode.DropAfterHeldRead &&
      (this.readWasHeldProbe?.() ?? false);
    const baseAddress = word(indexedAddress - indexRegister);
    const highByteMask = ((baseAddress >>> CPU_PAGE_SHIFT) + 1) & CPU_BYTE_MAX;
    const addressHighValue = sourceValue & highByteMask;
    const storedValue = readWasHeld ? sourceValue : addressHighValue;
    const pageCrossed = ((baseAddress ^ indexedAddress) & CPU_PAGE_SIZE) !== 0;
    const writeAddress = pageCrossed
      ? (addressHighValue << CPU_PAGE_SHIFT) | (indexedAddress & CPU_PAGE_OFFSET_MASK)
      : indexedAddress;
    this.memory.write(writeAddress, storedValue);
  }

  private dummyRead(address: number): void {
    this.memory.read(word(address));
  }

  private readBrkOrIrqVector(): number {
    // NMOS 6502 到 P 压栈后才最终选择向量。及时成熟的 NMI 因而能接管已经开始的
    // BRK/IRQ 微序列，但不会改变先前压入的 B 位或返回地址。
    const vector = this.nmiTakeoverProbe?.()
      ? CPU_VECTOR.nonMaskableInterrupt
      : CPU_VECTOR.interruptRequest;
    return this.memory.readWord(vector);
  }

  /**
   * 推进 KIL/JAM 后仍然存在的一个 CPU 总线周期。
   *
   * NMOS 核心不会再形成下一条指令边界，但地址总线会先经过复位向量附近的
   * 短暂序列，随后稳定在 $FFFF。每次调用只推进一个周期，整机因而仍能继续
   * 驱动 VIC-II、CIA、SID 和磁盘机等独立时钟域。
   */
  private executeJammedBusCycle(): number {
    const address =
      CPU_JAM_TRANSIENT_BUS_ADDRESSES[this.jamBusCycleIndex] ?? CPU_JAM_STABLE_BUS_ADDRESS;
    this.memory.read(address);
    if (this.jamBusCycleIndex < CPU_JAM_TRANSIENT_BUS_ADDRESSES.length) {
      this.jamBusCycleIndex += 1;
    }
    this.cyclesConsumed = 1;
    return this.cyclesConsumed;
  }

  // ------------------------------------------------------------------------
  // 栈访问
  // ------------------------------------------------------------------------

  /** 压入一个字节，然后按八位规则递减 SP。 */
  push(value: number) {
    this.memory.writeStack(this.sp, value);
    this.sp--;
    this.sp &= 0xff;
  }

  /** 按 6502 顺序先高字节、后低字节压入一个字。 */
  pushWord(value: number) {
    this.push((value >> 8) & 0xff);
    this.push(value & 0xff);
  }

  /** 先递增 SP，再弹出一个字节。 */
  pop() {
    this.sp++;
    this.sp &= 0xff;
    return this.memory.readStack(this.sp);
  }

  /** 按低字节、高字节顺序弹出一个字。 */
  popWord() {
    return this.pop() + this.pop() * 256;
  }

  // ------------------------------------------------------------------------
  // 反汇编
  // ------------------------------------------------------------------------

  disassemble(address: number, instructionCount?: number, dumpAdr?: boolean, dumpHex?: boolean) {
    let ret = '';

    if (typeof instructionCount == 'undefined') instructionCount = 1;
    if (typeof dumpAdr == 'undefined') dumpAdr = true;
    if (typeof dumpHex == 'undefined') dumpHex = true;

    for (let i = 1; i <= instructionCount; i++) {
      let d = '';
      let argument = 0;
      const opcode = this.memory.read(address);
      const opcodeInfo = this.requireOpcode(opcode);
      if (i > 1) {
        d += '\n';
      }
      if (dumpAdr) {
        d += hex(address, 4) + ':  ';
      }
      address++;
      if (dumpHex) {
        let hexBytes = '';
        d += hex(opcode, 2) + ' ';
        switch (opcodeInfo.length) {
          case 1:
            hexBytes = '       ';
            break;
          case 2: {
            const lo = this.memory.read(address++);
            argument = lo;
            hexBytes = hex(lo, 2) + '     ';
            break;
          }
          case 3: {
            const lo = this.memory.read(address++);
            const hi = this.memory.read(address++);
            argument = lo + hi * 256;
            hexBytes = hex(lo, 2) + ' ' + hex(hi, 2) + '  ';
            break;
          }
        }
        d += hexBytes;
      }
      let mnemo = opcodeInfo.mnemonic;
      if (opcodeInfo.length == 2) {
        mnemo = mnemo.split('aa').join(hex(argument, 2));
      } else if (opcodeInfo.length == 3) {
        mnemo = mnemo.split('aaaa').join(hex(argument, 4));
      }
      d += mnemo;
      ret += d.toUpperCase();
    }
    return ret;
  }

  private requireOpcode(opcode: number): CpuOpcode {
    const info = this.opcodes[opcode];
    if (!info) throw new RangeError(`Invalid 6502 opcode: ${opcode}.`);
    return info;
  }

  // ------------------------------------------------------------------------
  // 操作码表与查找表初始化
  // ------------------------------------------------------------------------

  getOpcodeTable(): CpuOpcode[] {
    return [
      new CpuOpcode(7, 1, () => this.opBRK(), null, 'brk'), // 00
      new CpuOpcode(
        6,
        2,
        (address) => this.opORA(address),
        () => this.byIndirectX(),
        'ora ($aa,x)',
      ), // 01
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 02
      new CpuOpcode(
        8,
        2,
        (address) => this.opASO(address),
        () => this.byIndirectX(),
        'aso ($aa,x)',
      ), // 03
      new CpuOpcode(
        3,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPage(),
        'nop $aa',
      ), // 04
      new CpuOpcode(
        3,
        2,
        (address) => this.opORA(address),
        () => this.byZeroPage(),
        'ora $aa',
      ), // 05
      new CpuOpcode(
        5,
        2,
        (address) => this.opASL(address),
        () => this.byZeroPage(),
        'asl $aa',
      ), // 06
      new CpuOpcode(
        5,
        2,
        (address) => this.opASO(address),
        () => this.byZeroPage(),
        'aso $aa',
      ), // 07
      new CpuOpcode(3, 1, () => this.opPHP(), null, 'php'), // 08
      new CpuOpcode(
        2,
        2,
        (address) => this.opORA(address),
        () => this.byImmediate(),
        'ora #$aa',
      ), // 09
      new CpuOpcode(2, 1, () => this.opASL_A(), null, 'asl a'), // 0a
      new CpuOpcode(
        2,
        2,
        () => this.opANC(),
        () => this.byImmediate(),
        'anc #$aa',
      ), // 0b
      new CpuOpcode(
        4,
        3,
        (address) => this.opUndocumentedNOP(address),
        () => this.byAbsolute(),
        'nop $aaaa',
      ), // 0c
      new CpuOpcode(
        4,
        3,
        (address) => this.opORA(address),
        () => this.byAbsolute(),
        'ora $aaaa',
      ), // 0d
      new CpuOpcode(
        6,
        3,
        (address) => this.opASL(address),
        () => this.byAbsolute(),
        'asl $aaaa',
      ), // 0e
      new CpuOpcode(
        6,
        3,
        (address) => this.opASO(address),
        () => this.byAbsolute(),
        'aso $aaaa',
      ), // 0f
      new CpuOpcode(
        2,
        2,
        () => this.opBPL(),
        () => this.byZeroPage(),
        'bpl $aa',
      ), // 10
      new CpuOpcode(
        5,
        2,
        (address) => this.opORA(address),
        () => this.byIndirectY(),
        'ora ($aa),y',
      ), // 11
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 12
      new CpuOpcode(
        8,
        2,
        (address) => this.opASO(address),
        () => this.byIndirectY(),
        'aso ($aa),y',
      ), // 13
      new CpuOpcode(
        4,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPageX(),
        'nop $aa,x',
      ), // 14
      new CpuOpcode(
        4,
        2,
        (address) => this.opORA(address),
        () => this.byZeroPageX(),
        'ora $aa,x',
      ), // 15
      new CpuOpcode(
        6,
        2,
        (address) => this.opASL(address),
        () => this.byZeroPageX(),
        'asl $aa,x',
      ), // 16
      new CpuOpcode(
        6,
        2,
        (address) => this.opASO(address),
        () => this.byZeroPageX(),
        'aso $aa,x',
      ), // 17
      new CpuOpcode(2, 1, () => this.opCLC(), null, 'clc'), // 18
      new CpuOpcode(
        4,
        3,
        (address) => this.opORA(address),
        () => this.byAbsoluteY(),
        'ora $aaaa,y',
      ), // 19
      new CpuOpcode(2, 1, () => this.opNOP(), null, 'nop'), // 1a
      new CpuOpcode(
        7,
        3,
        (address) => this.opASO(address),
        () => this.byAbsoluteY(),
        'aso $aaaa,y',
      ), // 1b
      new CpuOpcode(
        4,
        3,
        (address) => this.opUndocumentedNOP(address),
        () => this.byAbsoluteX(),
        'nop $aaaa,x',
      ), // 1c
      new CpuOpcode(
        4,
        3,
        (address) => this.opORA(address),
        () => this.byAbsoluteX(),
        'ora $aaaa,x',
      ), // 1d was 5
      new CpuOpcode(
        7,
        3,
        (address) => this.opASL(address),
        () => this.byAbsoluteX(),
        'asl $aaaa,x',
      ), // 1e
      new CpuOpcode(
        7,
        3,
        (address) => this.opASO(address),
        () => this.byAbsoluteX(),
        'aso $aaaa,x',
      ), // 1f
      new CpuOpcode(
        6,
        3,
        (address) => this.opJSR(address),
        () => this.byAbsolute(),
        'jsr $aaaa',
      ), // 20
      new CpuOpcode(
        6,
        2,
        (address) => this.opAND(address),
        () => this.byIndirectX(),
        'and ($aa,x)',
      ), // 21
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 22
      new CpuOpcode(
        8,
        2,
        (address) => this.opRLA(address),
        () => this.byIndirectX(),
        'rla ($aa,x)',
      ), // 23
      new CpuOpcode(
        3,
        2,
        (address) => this.opBIT(address),
        () => this.byZeroPage(),
        'bit $aa',
      ), // 24
      new CpuOpcode(
        3,
        2,
        (address) => this.opAND(address),
        () => this.byZeroPage(),
        'and $aa',
      ), // 25
      new CpuOpcode(
        5,
        2,
        (address) => this.opROL(address),
        () => this.byZeroPage(),
        'rol $aa',
      ), // 26
      new CpuOpcode(
        5,
        2,
        (address) => this.opRLA(address),
        () => this.byZeroPage(),
        'rla $aa',
      ), // 27
      new CpuOpcode(4, 1, () => this.opPLP(), null, 'plp'), // 28
      new CpuOpcode(
        2,
        2,
        (address) => this.opAND(address),
        () => this.byImmediate(),
        'and #$aa',
      ), // 29
      new CpuOpcode(2, 1, () => this.opROL_A(), null, 'rol a'), // 2a
      new CpuOpcode(
        2,
        2,
        () => this.opANC(),
        () => this.byImmediate(),
        'anc #$aa',
      ), // 2b
      new CpuOpcode(
        4,
        3,
        (address) => this.opBIT(address),
        () => this.byAbsolute(),
        'bit $aaaa',
      ), // 2c
      new CpuOpcode(
        4,
        3,
        (address) => this.opAND(address),
        () => this.byAbsolute(),
        'and $aaaa',
      ), // 2d
      new CpuOpcode(
        6,
        3,
        (address) => this.opROL(address),
        () => this.byAbsolute(),
        'rol $aaaa',
      ), // 2e
      new CpuOpcode(
        6,
        3,
        (address) => this.opRLA(address),
        () => this.byAbsolute(),
        'rla $aaaa',
      ), // 2f
      new CpuOpcode(
        2,
        2,
        () => this.opBMI(),
        () => this.byZeroPage(),
        'bmi $aa',
      ), // 30
      new CpuOpcode(
        5,
        2,
        (address) => this.opAND(address),
        () => this.byIndirectY(),
        'and ($aa),y',
      ), // 31
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 32
      new CpuOpcode(
        8,
        2,
        (address) => this.opRLA(address),
        () => this.byIndirectY(),
        'rla ($aa),y',
      ), // 33
      new CpuOpcode(
        4,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPageX(),
        'nop $aa,x',
      ), // 34
      new CpuOpcode(
        4,
        2,
        (address) => this.opAND(address),
        () => this.byZeroPageX(),
        'and $aa,x',
      ), // 35
      new CpuOpcode(
        6,
        2,
        (address) => this.opROL(address),
        () => this.byZeroPageX(),
        'rol $aa,x',
      ), // 36
      new CpuOpcode(
        6,
        2,
        (address) => this.opRLA(address),
        () => this.byZeroPageX(),
        'rla $aa,x',
      ), // 37
      new CpuOpcode(2, 1, () => this.opSEC(), null, 'sec'), // 38
      new CpuOpcode(
        4,
        3,
        (address) => this.opAND(address),
        () => this.byAbsoluteY(),
        'and $aaaa,y',
      ), // 39
      new CpuOpcode(2, 1, () => this.opNOP(), null, 'nop'), // 3a
      new CpuOpcode(
        7,
        3,
        (address) => this.opRLA(address),
        () => this.byAbsoluteY(),
        'rla $aaaa,y',
      ), // 3b
      new CpuOpcode(
        4,
        3,
        (address) => this.opUndocumentedNOP(address),
        () => this.byAbsoluteX(),
        'nop $aaaa,x',
      ), // 3c
      new CpuOpcode(
        4,
        3,
        (address) => this.opAND(address),
        () => this.byAbsoluteX(),
        'and $aaaa,x',
      ), // 3d was 5
      new CpuOpcode(
        7,
        3,
        (address) => this.opROL(address),
        () => this.byAbsoluteX(),
        'rol $aaaa,x',
      ), // 3e
      new CpuOpcode(
        7,
        3,
        (address) => this.opRLA(address),
        () => this.byAbsoluteX(),
        'rla $aaaa,x',
      ), // 3f
      new CpuOpcode(6, 1, () => this.opRTI(), null, 'rti'), // 40 was 4
      new CpuOpcode(
        6,
        2,
        (address) => this.opEOR(address),
        () => this.byIndirectX(),
        'eor ($aa,x)',
      ), // 41
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 42
      new CpuOpcode(
        8,
        2,
        (address) => this.opLSE(address),
        () => this.byIndirectX(),
        'lse ($aa,x)',
      ), // 43
      new CpuOpcode(
        3,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPage(),
        'nop $aa',
      ), // 44
      new CpuOpcode(
        3,
        2,
        (address) => this.opEOR(address),
        () => this.byZeroPage(),
        'eor $aa',
      ), // 45
      new CpuOpcode(
        5,
        2,
        (address) => this.opLSR(address),
        () => this.byZeroPage(),
        'lsr $aa',
      ), // 46
      new CpuOpcode(
        5,
        2,
        (address) => this.opLSE(address),
        () => this.byZeroPage(),
        'lse $aa',
      ), // 47
      new CpuOpcode(3, 1, () => this.opPHA(), null, 'pha'), // 48
      new CpuOpcode(
        2,
        2,
        (address) => this.opEOR(address),
        () => this.byImmediate(),
        'eor #$aa',
      ), // 49
      new CpuOpcode(2, 1, () => this.opLSR_A(), null, 'lsr a'), // 4a
      new CpuOpcode(
        2,
        2,
        () => this.opALR(),
        () => this.byImmediate(),
        'alr #$aa',
      ), // 4b
      new CpuOpcode(
        3,
        3,
        (address) => this.opJMP(address),
        () => this.byAbsolute(),
        'jmp $aaaa',
      ), // 4c
      new CpuOpcode(
        4,
        3,
        (address) => this.opEOR(address),
        () => this.byAbsolute(),
        'eor $aaaa',
      ), // 4d was 6
      new CpuOpcode(
        6,
        3,
        (address) => this.opLSR(address),
        () => this.byAbsolute(),
        'lsr $aaaa',
      ), // 4e
      new CpuOpcode(
        6,
        3,
        (address) => this.opLSE(address),
        () => this.byAbsolute(),
        'lse $aaaa',
      ), // 4f
      new CpuOpcode(
        2,
        2,
        () => this.opBVC(),
        () => this.byZeroPage(),
        'bvc $aa',
      ), // 50
      new CpuOpcode(
        5,
        2,
        (address) => this.opEOR(address),
        () => this.byIndirectY(),
        'eor ($aa),y',
      ), // 51
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 52
      new CpuOpcode(
        8,
        2,
        (address) => this.opLSE(address),
        () => this.byIndirectY(),
        'lse ($aa),y',
      ), // 53
      new CpuOpcode(
        4,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPageX(),
        'nop $aa,x',
      ), // 54
      new CpuOpcode(
        4,
        2,
        (address) => this.opEOR(address),
        () => this.byZeroPageX(),
        'eor $aa,x',
      ), // 55
      new CpuOpcode(
        6,
        2,
        (address) => this.opLSR(address),
        () => this.byZeroPageX(),
        'lsr $aa,x',
      ), // 56
      new CpuOpcode(
        6,
        2,
        (address) => this.opLSE(address),
        () => this.byZeroPageX(),
        'lse $aa,x',
      ), // 57
      new CpuOpcode(2, 1, () => this.opCLI(), null, 'cli'), // 58
      new CpuOpcode(
        4,
        3,
        (address) => this.opEOR(address),
        () => this.byAbsoluteY(),
        'eor $aaaa,y',
      ), // 59
      new CpuOpcode(2, 1, () => this.opNOP(), null, 'nop'), // 5a
      new CpuOpcode(
        7,
        3,
        (address) => this.opLSE(address),
        () => this.byAbsoluteY(),
        'lse $aaaa,y',
      ), // 5b
      new CpuOpcode(
        4,
        3,
        (address) => this.opUndocumentedNOP(address),
        () => this.byAbsoluteX(),
        'nop $aaaa,x',
      ), // 5c
      new CpuOpcode(
        4,
        3,
        (address) => this.opEOR(address),
        () => this.byAbsoluteX(),
        'eor $aaaa,x',
      ), // 5d was 5
      new CpuOpcode(
        7,
        3,
        (address) => this.opLSR(address),
        () => this.byAbsoluteX(),
        'lsr $aaaa,x',
      ), // 5e
      new CpuOpcode(
        7,
        3,
        (address) => this.opLSE(address),
        () => this.byAbsoluteX(),
        'lse $aaaa,x',
      ), // 5f
      new CpuOpcode(6, 1, () => this.opRTS(), null, 'rts'), // 60 was 4
      new CpuOpcode(
        6,
        2,
        (address) => this.opADC(address),
        () => this.byIndirectX(),
        'adc ($aa,x)',
      ), // 61
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 62
      new CpuOpcode(
        8,
        2,
        (address) => this.opRRA(address),
        () => this.byIndirectX(),
        'rra ($aa,x)',
      ), // 63
      new CpuOpcode(
        3,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPage(),
        'nop $aa',
      ), // 64
      new CpuOpcode(
        3,
        2,
        (address) => this.opADC(address),
        () => this.byZeroPage(),
        'adc $aa',
      ), // 65
      new CpuOpcode(
        5,
        2,
        (address) => this.opROR(address),
        () => this.byZeroPage(),
        'ror $aa',
      ), // 66
      new CpuOpcode(
        5,
        2,
        (address) => this.opRRA(address),
        () => this.byZeroPage(),
        'rra $aa',
      ), // 67
      new CpuOpcode(4, 1, () => this.opPLA(), null, 'pla'), // 68
      new CpuOpcode(
        2,
        2,
        (address) => this.opADC(address),
        () => this.byImmediate(),
        'adc #$aa',
      ), // 69
      new CpuOpcode(2, 1, () => this.opROR_A(), null, 'ror a'), // 6a
      new CpuOpcode(
        2,
        2,
        () => this.opARR(),
        () => this.byImmediate(),
        'arr #$aa',
      ), // 6b
      new CpuOpcode(
        5,
        3,
        (address) => this.opJMP(address),
        () => this.byIndirect(),
        'jmp ($aaaa)',
      ), // 6c
      new CpuOpcode(
        4,
        3,
        (address) => this.opADC(address),
        () => this.byAbsolute(),
        'adc $aaaa',
      ), // 6d
      new CpuOpcode(
        6,
        3,
        (address) => this.opROR(address),
        () => this.byAbsolute(),
        'ror $aaaa',
      ), // 6e
      new CpuOpcode(
        6,
        3,
        (address) => this.opRRA(address),
        () => this.byAbsolute(),
        'rra $aaaa',
      ), // 6f
      new CpuOpcode(
        2,
        2,
        () => this.opBVS(),
        () => this.byZeroPage(),
        'bvs $aa',
      ), // 70
      new CpuOpcode(
        5,
        2,
        (address) => this.opADC(address),
        () => this.byIndirectY(),
        'adc ($aa),y',
      ), // 71
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 72
      new CpuOpcode(
        8,
        2,
        (address) => this.opRRA(address),
        () => this.byIndirectY(),
        'rra ($aa),y',
      ), // 73
      new CpuOpcode(
        4,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPageX(),
        'nop $aa,x',
      ), // 74
      new CpuOpcode(
        4,
        2,
        (address) => this.opADC(address),
        () => this.byZeroPageX(),
        'adc $aa,x',
      ), // 75
      new CpuOpcode(
        6,
        2,
        (address) => this.opROR(address),
        () => this.byZeroPageX(),
        'ror $aa,x',
      ), // 76
      new CpuOpcode(
        6,
        2,
        (address) => this.opRRA(address),
        () => this.byZeroPageX(),
        'rra $aa,x',
      ), // 77
      new CpuOpcode(2, 1, () => this.opSEI(), null, 'sei'), // 78
      new CpuOpcode(
        4,
        3,
        (address) => this.opADC(address),
        () => this.byAbsoluteY(),
        'adc $aaaa,y',
      ), // 79
      new CpuOpcode(2, 1, () => this.opNOP(), null, 'nop'), // 7a
      new CpuOpcode(
        7,
        3,
        (address) => this.opRRA(address),
        () => this.byAbsoluteY(),
        'rra $aaaa,y',
      ), // 7b
      new CpuOpcode(
        4,
        3,
        (address) => this.opUndocumentedNOP(address),
        () => this.byAbsoluteX(),
        'nop $aaaa,x',
      ), // 7c
      new CpuOpcode(
        4,
        3,
        (address) => this.opADC(address),
        () => this.byAbsoluteX(),
        'adc $aaaa,x',
      ), // 7d was 5
      new CpuOpcode(
        7,
        3,
        (address) => this.opROR(address),
        () => this.byAbsoluteX(),
        'ror $aaaa,x',
      ), // 7e
      new CpuOpcode(
        7,
        3,
        (address) => this.opRRA(address),
        () => this.byAbsoluteX(),
        'rra $aaaa,x',
      ), // 7f
      new CpuOpcode(
        2,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byImmediate(),
        'nop #$aa',
      ), // 80
      new CpuOpcode(
        6,
        2,
        (address) => this.opSTA(address),
        () => this.byIndirectX(),
        'sta ($aa,x)',
      ), // 81
      new CpuOpcode(
        2,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byImmediate(),
        'nop #$aa',
      ), // 82
      new CpuOpcode(
        6,
        2,
        (address) => this.opAXS(address),
        () => this.byIndirectX(),
        'axs ($aa,x)',
      ), // 83
      new CpuOpcode(
        3,
        2,
        (address) => this.opSTY(address),
        () => this.byZeroPage(),
        'sty $aa',
      ), // 84
      new CpuOpcode(
        3,
        2,
        (address) => this.opSTA(address),
        () => this.byZeroPage(),
        'sta $aa',
      ), // 85
      new CpuOpcode(
        3,
        2,
        (address) => this.opSTX(address),
        () => this.byZeroPage(),
        'stx $aa',
      ), // 86
      new CpuOpcode(
        3,
        2,
        (address) => this.opAXS(address),
        () => this.byZeroPage(),
        'axs $aa',
      ), // 87
      new CpuOpcode(2, 1, () => this.opDEY(), null, 'dey'), // 88
      new CpuOpcode(
        2,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byImmediate(),
        'nop #$aa',
      ), // 89
      new CpuOpcode(2, 1, () => this.opTXA(), null, 'txa'), // 8a
      new CpuOpcode(
        2,
        2,
        () => this.opXAA(),
        () => this.byImmediate(),
        'xaa #$aa',
      ), // 8b
      new CpuOpcode(
        4,
        3,
        (address) => this.opSTY(address),
        () => this.byAbsolute(),
        'sty $aaaa',
      ), // 8c
      new CpuOpcode(
        4,
        3,
        (address) => this.opSTA(address),
        () => this.byAbsolute(),
        'sta $aaaa',
      ), // 8d
      new CpuOpcode(
        4,
        3,
        (address) => this.opSTX(address),
        () => this.byAbsolute(),
        'stx $aaaa',
      ), // 8e
      new CpuOpcode(
        4,
        3,
        (address) => this.opAXS(address),
        () => this.byAbsolute(),
        'axs $aaaa',
      ), // 8f
      new CpuOpcode(
        2,
        2,
        () => this.opBCC(),
        () => this.byZeroPage(),
        'bcc $aa',
      ), // 90
      new CpuOpcode(
        6,
        2,
        (address) => this.opSTA(address),
        () => this.byIndirectY(),
        'sta ($aa),y',
      ), // 91
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // 92
      new CpuOpcode(
        6,
        2,
        (address) => this.opAXA(address),
        () => this.byIndirectY(),
        'axa ($aa),y',
      ), // 93
      new CpuOpcode(
        4,
        2,
        (address) => this.opSTY(address),
        () => this.byZeroPageX(),
        'sty $aa,x',
      ), // 94
      new CpuOpcode(
        4,
        2,
        (address) => this.opSTA(address),
        () => this.byZeroPageX(),
        'sta $aa,x',
      ), // 95
      new CpuOpcode(
        4,
        2,
        (address) => this.opSTX(address),
        () => this.byZeroPageY(),
        'stx $aa,y',
      ), // 96
      new CpuOpcode(
        4,
        2,
        (address) => this.opAXS(address),
        () => this.byZeroPageY(),
        'axs $aa,y',
      ), // 97
      new CpuOpcode(2, 1, () => this.opTYA(), null, 'tya'), // 98
      new CpuOpcode(
        5,
        3,
        (address) => this.opSTA(address),
        () => this.byAbsoluteY(),
        'sta $aaaa,y',
      ), // 99
      new CpuOpcode(2, 1, () => this.opTXS(), null, 'txs'), // 9a
      new CpuOpcode(
        5,
        3,
        (address) => this.opTAS(address),
        () => this.byAbsoluteY(),
        'tas $aaaa,y',
      ), // 9b
      new CpuOpcode(
        5,
        3,
        (address) => this.opSAY(address),
        () => this.byAbsoluteX(),
        'say $aaaa,x',
      ), // 9c
      new CpuOpcode(
        5,
        3,
        (address) => this.opSTA(address),
        () => this.byAbsoluteX(),
        'sta $aaaa,x',
      ), // 9d
      new CpuOpcode(
        5,
        3,
        (address) => this.opXAS(address),
        () => this.byAbsoluteY(),
        'xas $aaaa,y',
      ), // 9e
      new CpuOpcode(
        5,
        3,
        (address) => this.opAXA(address),
        () => this.byAbsoluteY(),
        'axa $aaaa,y',
      ), // 9f
      new CpuOpcode(
        2,
        2,
        (address) => this.opLDY(address),
        () => this.byImmediate(),
        'ldy #$aa',
      ), // a0
      new CpuOpcode(
        6,
        2,
        (address) => this.opLDA(address),
        () => this.byIndirectX(),
        'lda ($aa,x)',
      ), // a1
      new CpuOpcode(
        2,
        2,
        (address) => this.opLDX(address),
        () => this.byImmediate(),
        'ldx #$aa',
      ), // a2
      new CpuOpcode(
        6,
        2,
        (address) => this.opLAX(address),
        () => this.byIndirectX(),
        'lax ($aa,x)',
      ), // a3
      new CpuOpcode(
        3,
        2,
        (address) => this.opLDY(address),
        () => this.byZeroPage(),
        'ldy $aa',
      ), // a4
      new CpuOpcode(
        3,
        2,
        (address) => this.opLDA(address),
        () => this.byZeroPage(),
        'lda $aa',
      ), // a5
      new CpuOpcode(
        3,
        2,
        (address) => this.opLDX(address),
        () => this.byZeroPage(),
        'ldx $aa',
      ), // a6
      new CpuOpcode(
        3,
        2,
        (address) => this.opLAX(address),
        () => this.byZeroPage(),
        'lax $aa',
      ), // a7
      new CpuOpcode(2, 1, () => this.opTAY(), null, 'tay'), // a8
      new CpuOpcode(
        2,
        2,
        (address) => this.opLDA(address),
        () => this.byImmediate(),
        'lda #$aa',
      ), // a9
      new CpuOpcode(2, 1, () => this.opTAX(), null, 'tax'), // aa
      new CpuOpcode(
        2,
        2,
        (address) => this.opOAL(address),
        () => this.byImmediate(),
        'oal #$aa',
      ), // ab
      new CpuOpcode(
        4,
        3,
        (address) => this.opLDY(address),
        () => this.byAbsolute(),
        'ldy $aaaa',
      ), // ac
      new CpuOpcode(
        4,
        3,
        (address) => this.opLDA(address),
        () => this.byAbsolute(),
        'lda $aaaa',
      ), // ad
      new CpuOpcode(
        4,
        3,
        (address) => this.opLDX(address),
        () => this.byAbsolute(),
        'ldx $aaaa',
      ), // ae
      new CpuOpcode(
        4,
        3,
        (address) => this.opLAX(address),
        () => this.byAbsolute(),
        'lax $aaaa',
      ), // af
      new CpuOpcode(
        2,
        2,
        () => this.opBCS(),
        () => this.byZeroPage(),
        'bcs $aa',
      ), // b0
      new CpuOpcode(
        5,
        2,
        (address) => this.opLDA(address),
        () => this.byIndirectY(),
        'lda ($aa),y',
      ), // b1
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // b2
      new CpuOpcode(
        5,
        2,
        (address) => this.opLAX(address),
        () => this.byIndirectY(),
        'lax ($aa),y',
      ), // b3
      new CpuOpcode(
        4,
        2,
        (address) => this.opLDY(address),
        () => this.byZeroPageX(),
        'ldy $aa,x',
      ), // b4
      new CpuOpcode(
        4,
        2,
        (address) => this.opLDA(address),
        () => this.byZeroPageX(),
        'lda $aa,x',
      ), // b5
      new CpuOpcode(
        4,
        2,
        (address) => this.opLDX(address),
        () => this.byZeroPageY(),
        'ldx $aa,y',
      ), // b6
      new CpuOpcode(
        4,
        2,
        (address) => this.opLAX(address),
        () => this.byZeroPageY(),
        'lax $aa,y',
      ), // b7
      new CpuOpcode(2, 1, () => this.opCLV(), null, 'clv'), // b8
      new CpuOpcode(
        4,
        3,
        (address) => this.opLDA(address),
        () => this.byAbsoluteY(),
        'lda $aaaa,y',
      ), // b9
      new CpuOpcode(2, 1, () => this.opTSX(), null, 'tsx'), // ba
      new CpuOpcode(
        4,
        3,
        (address) => this.opLAS(address),
        () => this.byAbsoluteY(),
        'las $aaaa,y',
      ), // bb
      new CpuOpcode(
        4,
        3,
        (address) => this.opLDY(address),
        () => this.byAbsoluteX(),
        'ldy $aaaa,x',
      ), // bc
      new CpuOpcode(
        4,
        3,
        (address) => this.opLDA(address),
        () => this.byAbsoluteX(),
        'lda $aaaa,x',
      ), // bd
      new CpuOpcode(
        4,
        3,
        (address) => this.opLDX(address),
        () => this.byAbsoluteY(),
        'ldx $aaaa,y',
      ), // be
      new CpuOpcode(
        4,
        3,
        (address) => this.opLAX(address),
        () => this.byAbsoluteY(),
        'lax $aaaa,y',
      ), // bf
      new CpuOpcode(
        2,
        2,
        (address) => this.opCPY(address),
        () => this.byImmediate(),
        'cpy #$aa',
      ), // c0
      new CpuOpcode(
        6,
        2,
        (address) => this.opCMP(address),
        () => this.byIndirectX(),
        'cmp ($aa,x)',
      ), // c1
      new CpuOpcode(
        2,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byImmediate(),
        'nop #$aa',
      ), // c2
      new CpuOpcode(
        8,
        2,
        (address) => this.opDCM(address),
        () => this.byIndirectX(),
        'dcm ($aa,x)',
      ), // c3
      new CpuOpcode(
        3,
        2,
        (address) => this.opCPY(address),
        () => this.byZeroPage(),
        'cpy $aa',
      ), // c4
      new CpuOpcode(
        3,
        2,
        (address) => this.opCMP(address),
        () => this.byZeroPage(),
        'cmp $aa',
      ), // c5
      new CpuOpcode(
        5,
        2,
        (address) => this.opDEC(address),
        () => this.byZeroPage(),
        'dec $aa',
      ), // c6
      new CpuOpcode(
        5,
        2,
        (address) => this.opDCM(address),
        () => this.byZeroPage(),
        'dcm $aa',
      ), // c7
      new CpuOpcode(2, 1, () => this.opINY(), null, 'iny'), // c8
      new CpuOpcode(
        2,
        2,
        (address) => this.opCMP(address),
        () => this.byImmediate(),
        'cmp #$aa',
      ), // c9
      new CpuOpcode(2, 1, () => this.opDEX(), null, 'dex'), // ca
      new CpuOpcode(
        2,
        2,
        (address) => this.opSAX(address),
        () => this.byImmediate(),
        'sax #$aa',
      ), // cb
      new CpuOpcode(
        4,
        3,
        (address) => this.opCPY(address),
        () => this.byAbsolute(),
        'cpy $aaaa',
      ), // cc
      new CpuOpcode(
        4,
        3,
        (address) => this.opCMP(address),
        () => this.byAbsolute(),
        'cmp $aaaa',
      ), // cd
      new CpuOpcode(
        6,
        3,
        (address) => this.opDEC(address),
        () => this.byAbsolute(),
        'dec $aaaa',
      ), // ce
      new CpuOpcode(
        6,
        3,
        (address) => this.opDCM(address),
        () => this.byAbsolute(),
        'dcm $aaaa',
      ), // cf
      new CpuOpcode(
        2,
        2,
        () => this.opBNE(),
        () => this.byZeroPage(),
        'bne $aa',
      ), // d0
      new CpuOpcode(
        5,
        2,
        (address) => this.opCMP(address),
        () => this.byIndirectY(),
        'cmp ($aa),y',
      ), // d1
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // d2
      new CpuOpcode(
        8,
        2,
        (address) => this.opDCM(address),
        () => this.byIndirectY(),
        'dcm ($aa),y',
      ), // d3
      new CpuOpcode(
        4,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPageX(),
        'nop $aa,x',
      ), // d4
      new CpuOpcode(
        4,
        2,
        (address) => this.opCMP(address),
        () => this.byZeroPageX(),
        'cmp $aa,x',
      ), // d5
      new CpuOpcode(
        6,
        2,
        (address) => this.opDEC(address),
        () => this.byZeroPageX(),
        'dec $aa,x',
      ), // d6
      new CpuOpcode(
        6,
        2,
        (address) => this.opDCM(address),
        () => this.byZeroPageX(),
        'dcm $aa,x',
      ), // d7
      new CpuOpcode(2, 1, () => this.opCLD(), null, 'cld'), // d8
      new CpuOpcode(
        4,
        3,
        (address) => this.opCMP(address),
        () => this.byAbsoluteY(),
        'cmp $aaaa,y',
      ), // d9
      new CpuOpcode(2, 1, () => this.opNOP(), null, 'nop'), // da
      new CpuOpcode(
        7,
        3,
        (address) => this.opDCM(address),
        () => this.byAbsoluteY(),
        'dcm $aaaa,y',
      ), // db
      new CpuOpcode(
        4,
        3,
        (address) => this.opUndocumentedNOP(address),
        () => this.byAbsoluteX(),
        'nop $aaaa,x',
      ), // dc
      new CpuOpcode(
        4,
        3,
        (address) => this.opCMP(address),
        () => this.byAbsoluteX(),
        'cmp $aaaa,x',
      ), // dd was 5
      new CpuOpcode(
        7,
        3,
        (address) => this.opDEC(address),
        () => this.byAbsoluteX(),
        'dec $aaaa,x',
      ), // de
      new CpuOpcode(
        7,
        3,
        (address) => this.opDCM(address),
        () => this.byAbsoluteX(),
        'dcm $aaaa,x',
      ), // df
      new CpuOpcode(
        2,
        2,
        (address) => this.opCPX(address),
        () => this.byImmediate(),
        'cpx #$aa',
      ), // e0
      new CpuOpcode(
        6,
        2,
        (address) => this.opSBC(address),
        () => this.byIndirectX(),
        'sbc ($aa,x)',
      ), // e1
      new CpuOpcode(
        2,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byImmediate(),
        'nop #$aa',
      ), // e2
      new CpuOpcode(
        8,
        2,
        (address) => this.opINS(address),
        () => this.byIndirectX(),
        'ins ($aa,x)',
      ), // e3
      new CpuOpcode(
        3,
        2,
        (address) => this.opCPX(address),
        () => this.byZeroPage(),
        'cpx $aa',
      ), // e4
      new CpuOpcode(
        3,
        2,
        (address) => this.opSBC(address),
        () => this.byZeroPage(),
        'sbc $aa',
      ), // e5
      new CpuOpcode(
        5,
        2,
        (address) => this.opINC(address),
        () => this.byZeroPage(),
        'inc $aa',
      ), // e6
      new CpuOpcode(
        5,
        2,
        (address) => this.opINS(address),
        () => this.byZeroPage(),
        'ins $aa',
      ), // e7
      new CpuOpcode(2, 1, () => this.opINX(), null, 'inx'), // e8
      new CpuOpcode(
        2,
        2,
        (address) => this.opSBC(address),
        () => this.byImmediate(),
        'sbc #$aa',
      ), // e9
      new CpuOpcode(2, 1, () => this.opNOP(), null, 'nop'), // ea
      new CpuOpcode(
        2,
        2,
        (address) => this.opSBC(address),
        () => this.byImmediate(),
        'sbc #$aa',
      ), // eb
      new CpuOpcode(
        4,
        3,
        (address) => this.opCPX(address),
        () => this.byAbsolute(),
        'cpx $aaaa',
      ), // ec
      new CpuOpcode(
        4,
        3,
        (address) => this.opSBC(address),
        () => this.byAbsolute(),
        'sbc $aaaa',
      ), // ed
      new CpuOpcode(
        6,
        3,
        (address) => this.opINC(address),
        () => this.byAbsolute(),
        'inc $aaaa',
      ), // ee
      new CpuOpcode(
        6,
        3,
        (address) => this.opINS(address),
        () => this.byAbsolute(),
        'ins $aaaa',
      ), // ef
      new CpuOpcode(
        2,
        2,
        () => this.opBEQ(),
        () => this.byZeroPage(),
        'beq $aa',
      ), // f0
      new CpuOpcode(
        5,
        2,
        (address) => this.opSBC(address),
        () => this.byIndirectY(),
        'sbc ($aa),y',
      ), // f1
      new CpuOpcode(2, 1, () => this.opHLT(), null, 'hlt'), // f2
      new CpuOpcode(
        8,
        2,
        (address) => this.opINS(address),
        () => this.byIndirectY(),
        'ins ($aa),y',
      ), // f3
      new CpuOpcode(
        4,
        2,
        (address) => this.opUndocumentedNOP(address),
        () => this.byZeroPageX(),
        'nop $aa,x',
      ), // f4
      new CpuOpcode(
        4,
        2,
        (address) => this.opSBC(address),
        () => this.byZeroPageX(),
        'sbc $aa,x',
      ), // f5
      new CpuOpcode(
        6,
        2,
        (address) => this.opINC(address),
        () => this.byZeroPageX(),
        'inc $aa,x',
      ), // f6
      new CpuOpcode(
        6,
        2,
        (address) => this.opINS(address),
        () => this.byZeroPageX(),
        'ins $aa,x',
      ), // f7
      new CpuOpcode(2, 1, () => this.opSED(), null, 'sed'), // f8
      new CpuOpcode(
        4,
        3,
        (address) => this.opSBC(address),
        () => this.byAbsoluteY(),
        'sbc $aaaa,y',
      ), // f9
      new CpuOpcode(2, 1, () => this.opNOP(), null, 'nop'), // fa
      new CpuOpcode(
        7,
        3,
        (address) => this.opINS(address),
        () => this.byAbsoluteY(),
        'ins $aaaa,y',
      ), // fb
      new CpuOpcode(
        4,
        3,
        (address) => this.opUndocumentedNOP(address),
        () => this.byAbsoluteX(),
        'nop $aaaa,x',
      ), // fc
      new CpuOpcode(
        4,
        3,
        (address) => this.opSBC(address),
        () => this.byAbsoluteX(),
        'sbc $aaaa,x',
      ), // fd was 5
      new CpuOpcode(
        7,
        3,
        (address) => this.opINC(address),
        () => this.byAbsoluteX(),
        'inc $aaaa,x',
      ), // fe
      new CpuOpcode(
        7,
        3,
        (address) => this.opINS(address),
        () => this.byAbsoluteX(),
        'ins $aaaa,x',
      ), // ff
    ];
  }

  private getTwoComplementTable(): Uint8Array {
    return Uint8Array.from({ length: 0x100 }, (_unused, value) =>
      value === 0 ? CpuStatusFlag.Zero : value & CpuStatusFlag.Negative,
    );
  }
}

function requireCpuRegisterByte(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > CPU_BYTE_MAX) {
    throw new RangeError(`CPU register ${name} must be an integer from 0 through 255.`);
  }
  return value;
}

function requireCpuProgramCounter(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > CPU_ADDRESS_MAX) {
    throw new RangeError('CPU program counter must be an integer from 0 through 65535.');
  }
  return value;
}
