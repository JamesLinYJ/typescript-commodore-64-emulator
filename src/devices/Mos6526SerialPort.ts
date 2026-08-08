// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6526 串行移位寄存器
//
//   文件:       Mos6526SerialPort.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../shared/numbers';

const SERIAL_BYTE_BIT_COUNT = 8;
const SERIAL_TRANSFER_HALF_BIT_COUNT = SERIAL_BYTE_BIT_COUNT * 2;
const SERIAL_MOST_SIGNIFICANT_BIT = 0x80;
const SERIAL_INTERRUPT_DELAY_CYCLES = 2;
const OUTPUT_REGISTER_LOAD_DELAY_CYCLES = 2;
const OUTPUT_REGISTER_LOAD_PIPELINE_INPUT = 1 << (OUTPUT_REGISTER_LOAD_DELAY_CYCLES - 1);
const OUTPUT_CLOCK_TRANSITION_DELAY_CYCLES = 2;
const OUTPUT_CLOCK_PIPELINE_INPUT = 1 << (OUTPUT_CLOCK_TRANSITION_DELAY_CYCLES - 1);

export interface Mos6526SerialInputResult {
  readonly completed: boolean;
  readonly value: number;
}

/**
 * 保存 CIA 串行口独立于寄存器映射和中断控制器的移位状态。
 *
 * 输出模式下，Timer A 每次下溢只翻转一次 CNT；完整数据位需要低、高两个半位，
 * 因而一个字节经过 16 次下溢后完成。输入模式由外部 CNT 上升沿直接推进八位移位。
 */
export class Mos6526SerialPort {
  private bufferedOutputByte: number | undefined;
  private inputBitsReceived = 0;
  private inputShiftRegister = 0;
  private interruptDelayCycles: number | undefined;
  private outputClockHigh = true;
  private outputDataHigh = true;
  private outputDataRegister = 0;
  private outputClockPipeline = 0;
  private outputHalfBitsRemaining = 0;
  private outputLoadPipeline = 0;
  private outputShiftRegister = 0;
  private seamlessOutputByte: number | undefined;

  get clockOutputHigh(): boolean {
    return this.outputClockHigh;
  }

  get dataOutputHigh(): boolean {
    return this.outputDataHigh;
  }

  get outputActive(): boolean {
    return this.outputHalfBitsRemaining > 0;
  }

  /** 只有延迟管线中存在事件时，处理器时钟才会改变串行口状态。 */
  get cycleWorkPending(): boolean {
    return (
      this.outputLoadPipeline !== 0 ||
      this.outputClockPipeline !== 0 ||
      this.interruptDelayCycles !== undefined
    );
  }

  reset(): void {
    this.bufferedOutputByte = undefined;
    this.inputBitsReceived = 0;
    this.inputShiftRegister = 0;
    this.interruptDelayCycles = undefined;
    this.outputClockHigh = true;
    this.outputDataHigh = true;
    this.outputDataRegister = 0;
    this.outputClockPipeline = 0;
    this.outputHalfBitsRemaining = 0;
    this.outputLoadPipeline = 0;
    this.outputShiftRegister = 0;
    this.seamlessOutputByte = undefined;
  }

  /** 写入 SDR 输出缓冲器；数据经过两个芯片周期后才尝试装入内部移位寄存器。 */
  writeOutputByte(value: number): void {
    this.outputDataRegister = byte(value);
    this.outputLoadPipeline |= OUTPUT_REGISTER_LOAD_PIPELINE_INPUT;
  }

  /** Timer A 下溢后，CNT 的实际翻转还要经过内部两级时钟管线。 */
  scheduleOutputClockTransition(): void {
    if (!this.outputActive && this.bufferedOutputByte === undefined) return;
    this.outputClockPipeline |= OUTPUT_CLOCK_PIPELINE_INPUT;
  }

  /**
   * 处理一次 Timer A 下溢产生的 CNT 半周期。
   *
   * @returns 本次边沿完成了一个八位输出字节时为 `true`。
   */
  clockOutputHalfBit(): boolean {
    if (!this.outputActive) return false;

    this.outputClockHigh = !this.outputClockHigh;
    this.outputHalfBitsRemaining -= 1;
    if (this.outputHalfBitsRemaining === 1) {
      // 最后一个数据位送上 SP 时移位寄存器已经空；ICR 的 SDR 源在两个芯片周期后锁存。
      this.interruptDelayCycles = SERIAL_INTERRUPT_DELAY_CYCLES;
      if (this.seamlessOutputByte === undefined && this.bufferedOutputByte !== undefined) {
        this.seamlessOutputByte = this.bufferedOutputByte;
        this.bufferedOutputByte = undefined;
      }
    }
    if (this.outputClockHigh) {
      this.outputShiftRegister = byte(this.outputShiftRegister << 1);
      this.outputDataHigh = (this.outputShiftRegister & SERIAL_MOST_SIGNIFICANT_BIT) !== 0;
    }

    if (this.outputHalfBitsRemaining > 0) return false;

    const seamlessByte = this.seamlessOutputByte;
    const nextByte = seamlessByte ?? this.bufferedOutputByte;
    this.seamlessOutputByte = undefined;
    if (seamlessByte === undefined) this.bufferedOutputByte = undefined;
    if (nextByte === undefined) {
      this.outputDataHigh = true;
    } else {
      this.loadOutputShiftRegister(nextByte);
    }
    return true;
  }

  /** 推进 SDR 装载、完成中断和 CNT 翻转三条独立的内部延迟管线。 */
  tickCycle(): boolean {
    if (!this.cycleWorkPending) return false;

    const outputLoadDue = (this.outputLoadPipeline & 1) !== 0;
    this.outputLoadPipeline >>>= 1;
    if (outputLoadDue) this.loadOutputDataRegister();

    let interruptRaised = false;
    const remaining = this.interruptDelayCycles;
    if (remaining !== undefined) {
      if (remaining > 1) {
        this.interruptDelayCycles = remaining - 1;
      } else {
        this.interruptDelayCycles = undefined;
        interruptRaised = true;
      }
    }

    const outputClockDue = (this.outputClockPipeline & 1) !== 0;
    this.outputClockPipeline >>>= 1;
    if (outputClockDue) this.clockOutputHalfBit();
    return interruptRaised;
  }

  /** 在输入模式下采样一次外部 CNT 上升沿及其 SP 电平。 */
  clockInputBit(inputHigh: boolean): Mos6526SerialInputResult {
    this.inputShiftRegister = byte((this.inputShiftRegister << 1) | (inputHigh ? 1 : 0));
    this.inputBitsReceived += 1;
    if (this.inputBitsReceived < SERIAL_BYTE_BIT_COUNT) {
      return { completed: false, value: this.inputShiftRegister };
    }

    this.inputBitsReceived = 0;
    return { completed: true, value: this.inputShiftRegister };
  }

  private loadOutputShiftRegister(value: number): void {
    this.outputShiftRegister = value;
    this.outputHalfBitsRemaining = SERIAL_TRANSFER_HALF_BIT_COUNT;
    this.outputClockHigh = true;
    this.outputDataHigh = (value & SERIAL_MOST_SIGNIFICANT_BIT) !== 0;
  }

  private loadOutputDataRegister(): void {
    if (!this.outputActive) {
      this.loadOutputShiftRegister(this.outputDataRegister);
      return;
    }

    // 在第十五个半位后，旧字节还差 CNT 回到高电平；此时可把下一字节直接接入移位器，
    // 因而 SDR 缓冲器仍能接受第三个字节，而不会覆盖已经接入的第二个字节。
    if (this.outputHalfBitsRemaining === 1 && this.seamlessOutputByte === undefined) {
      this.seamlessOutputByte = this.outputDataRegister;
      return;
    }
    this.bufferedOutputByte = this.outputDataRegister;
  }
}
