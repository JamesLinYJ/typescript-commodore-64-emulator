// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CPU 中断采样时序
//
//   文件:       CpuInterruptTiming.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export interface CompletedCpuInstruction {
  readonly interruptMaskedAfter: boolean;
  readonly interruptMaskedBefore: boolean;
  readonly opcode: number;
}

type MaskableInterruptTransition = 'becameDisabled' | 'becameEnabled' | 'unchanged';

const RETURN_FROM_INTERRUPT_OPCODE = 0x40;
const BREAK_OPCODE = 0x00;
const NORMAL_INTERRUPT_RECOGNITION_CYCLES = 2;
const BRANCH_INTERRUPT_RECOGNITION_CYCLES = 3;

/**
 * 模拟 NMOS 6502 在指令边界采样 IRQ/NMI 的内部规则。
 *
 * 物理线归属和边沿时间由整机调度器维护；这里仅保存 I 标志修改延迟、已采用分支多出的
 * 识别周期，以及 BRK 对紧邻 NMI 的抑制语义。
 */
export class CpuInterruptTiming {
  private currentInstructionDelaysInterrupt = false;
  private previousInstructionDelaysInterrupt = false;
  private previousMaskTransition: MaskableInterruptTransition = 'unchanged';
  private previousOpcode: number | undefined;

  beginInstruction(): void {
    this.currentInstructionDelaysInterrupt = false;
  }

  delayInterruptForTakenBranch(): void {
    this.currentInstructionDelaysInterrupt = true;
  }

  completeInstruction(instruction: CompletedCpuInstruction): void {
    const { interruptMaskedAfter, interruptMaskedBefore, opcode } = instruction;
    this.previousMaskTransition =
      opcode === RETURN_FROM_INTERRUPT_OPCODE ||
      opcode === BREAK_OPCODE ||
      interruptMaskedBefore === interruptMaskedAfter
        ? 'unchanged'
        : interruptMaskedAfter
          ? 'becameDisabled'
          : 'becameEnabled';
    this.previousInstructionDelaysInterrupt = this.currentInstructionDelaysInterrupt;
    this.previousOpcode = opcode;
  }

  canAcceptMaskableInterrupt(assertedCycles: number, interruptMasked: boolean): boolean {
    const requiredCycles = this.requiredRecognitionCycles();
    if (assertedCycles < requiredCycles) return false;
    if (this.previousMaskTransition === 'becameEnabled') return false;
    return !interruptMasked || this.previousMaskTransition === 'becameDisabled';
  }

  canAcceptNonMaskableInterrupt(assertedCycles: number): boolean {
    if (this.previousOpcode === BREAK_OPCODE) return false;
    return assertedCycles >= this.requiredRecognitionCycles();
  }

  canTakeOverInterruptSequenceWithNmi(assertedCycles: number): boolean {
    // BRK/IRQ 的向量选择发生在独立的 T5 阶段，不继承上一条分支的额外边界延迟。
    return assertedCycles >= NORMAL_INTERRUPT_RECOGNITION_CYCLES;
  }

  /**
   * 完成一次硬件 IRQ/NMI 入口序列。
   *
   * NMOS 6502 与 BRK 共用这段“虚拟 BRK”微序列。若 NMI 在压 P 时才成熟，
   * 它会错过当前向量选择，也不能在向量读完后立即再入；必须先完成 handler
   * 的首条指令。记住虚拟 BRK 可与真实 BRK 共用同一边界规则。
   */
  completeInterruptEntry(): void {
    this.previousMaskTransition = 'unchanged';
    this.previousInstructionDelaysInterrupt = false;
    this.previousOpcode = BREAK_OPCODE;
  }

  reset(): void {
    this.currentInstructionDelaysInterrupt = false;
    this.previousInstructionDelaysInterrupt = false;
    this.previousMaskTransition = 'unchanged';
    this.previousOpcode = undefined;
  }

  private requiredRecognitionCycles(): number {
    return this.previousInstructionDelaysInterrupt
      ? BRANCH_INTERRUPT_RECOGNITION_CYCLES
      : NORMAL_INTERRUPT_RECOGNITION_CYCLES;
  }
}
