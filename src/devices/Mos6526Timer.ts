// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6526 定时器状态机
//
//   文件:       Mos6526Timer.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../shared/numbers';
import { CIA_TIMER_B_INPUT_MODE, CIA_TIMER_CONTROL_BIT } from './ciaRegisters';

const TIMER_STATE = {
  start: 0x0001,
  countStage2: 0x0002,
  externalStep: 0x0004,
  oneShotControl: 0x0008,
  forceLoadControl: 0x0010,
  processorClockInput: 0x0020,
  countStage3: 0x0040,
  loadStage1: 0x0080,
  oneShotStage0: 0x0100,
  load: 0x0200,
  output: 0x0400,
  count: 0x0800,
  oneShot: 0x1000,
} as const;

const CONTROL_STATE_MASK =
  TIMER_STATE.start |
  TIMER_STATE.oneShotControl |
  TIMER_STATE.forceLoadControl |
  TIMER_STATE.processorClockInput;

// COUNT 与 LOAD 信号在 6526 内部经过延迟级传播，不能等价为“每条 CPU 指令减一次”。
// 位状态管线逐个芯片周期推进这些信号，确保强制装载、单次模式和下溢发生在正确边沿。
export class Mos6526Timer {
  counter = 0xffff;
  inputMode: number = CIA_TIMER_B_INPUT_MODE.processorClock;
  latch = 0xffff;
  toggleOutput = false;

  private state = 0;
  // 单周期下溢脉冲与翻转触发器是两条独立信号；OUTMODE 只负责选择输出，
  // 因而切换模式时不能用当前引脚电平反推或覆盖另一条信号的历史状态。
  private underflowPulseActive = false;
  private toggleStateHigh = false;

  get running(): boolean {
    return (this.state & TIMER_STATE.start) !== 0;
  }

  get outputHigh(): boolean {
    return this.toggleOutput ? this.toggleStateHigh : this.underflowPulseActive;
  }

  reset(): void {
    this.counter = 0xffff;
    this.inputMode = CIA_TIMER_B_INPUT_MODE.processorClock;
    this.latch = 0xffff;
    this.toggleOutput = false;
    this.state = 0;
    this.underflowPulseActive = false;
    this.toggleStateHigh = false;
  }

  writeLatchLow(value: number): void {
    this.latch = (this.latch & 0xff00) | byte(value);
    if ((this.state & TIMER_STATE.load) !== 0) {
      this.counter = (this.counter & 0xff00) | byte(value);
    }
  }

  writeLatchHigh(value: number): void {
    this.latch = ((byte(value) << 8) | (this.latch & 0x00ff)) & 0xffff;
    if ((this.state & TIMER_STATE.load) !== 0 || !this.running) {
      this.counter = this.latch;
    }
  }

  writeControl(value: number, inputMode: number): void {
    const wasRunning = this.running;
    this.inputMode = inputMode;
    this.toggleOutput = (value & CIA_TIMER_CONTROL_BIT.toggleOutput) !== 0;
    this.state &= ~CONTROL_STATE_MASK;
    if ((value & CIA_TIMER_CONTROL_BIT.start) !== 0) this.state |= TIMER_STATE.start;
    if (!wasRunning && (this.state & TIMER_STATE.start) !== 0) this.toggleStateHigh = true;
    if ((value & CIA_TIMER_CONTROL_BIT.oneShot) !== 0) {
      this.state |= TIMER_STATE.oneShotControl;
    }
    if ((value & CIA_TIMER_CONTROL_BIT.forceLoad) !== 0) {
      this.state |= TIMER_STATE.forceLoadControl;
    }
    if (inputMode === CIA_TIMER_B_INPUT_MODE.processorClock) {
      this.state |= TIMER_STATE.processorClockInput;
    }
  }

  tickCycle(externalStep = false): boolean {
    this.underflowPulseActive = false;
    if (externalStep && this.running) this.state |= TIMER_STATE.externalStep;

    if (this.counter !== 0 && (this.state & TIMER_STATE.countStage3) !== 0) {
      this.counter = (this.counter - 1) & 0xffff;
    }
    this.state = this.nextState(this.state);

    let underflow = false;
    if (this.counter === 0 && (this.state & TIMER_STATE.countStage3) !== 0) {
      this.state |= TIMER_STATE.load | TIMER_STATE.output;
      underflow = true;
    }
    if ((this.state & TIMER_STATE.load) !== 0) {
      this.counter = this.latch;
      this.state &= ~TIMER_STATE.countStage3;
    }
    if (
      (this.state & TIMER_STATE.output) !== 0 &&
      (this.state & (TIMER_STATE.oneShot | TIMER_STATE.oneShotStage0)) !== 0
    ) {
      this.state &= ~(TIMER_STATE.start | TIMER_STATE.countStage2);
    }
    if (underflow) this.updateOutput();
    return underflow;
  }

  scheduleExternalStep(): void {
    // 外部 STEP 在当前芯片周期结束时进入计数管线，不能反向作用于本周期已经完成的
    // COUNT/LOAD 判定。Timer A 级联到 Timer B 也走同一条内部路径。
    if (this.running) this.state |= TIMER_STATE.externalStep;
  }

  private nextState(state: number): number {
    let next =
      state & (TIMER_STATE.start | TIMER_STATE.oneShotControl | TIMER_STATE.processorClockInput);

    if ((state & TIMER_STATE.start) !== 0 && (state & TIMER_STATE.processorClockInput) !== 0) {
      next |= TIMER_STATE.countStage2;
    }
    if (
      (state & TIMER_STATE.countStage2) !== 0 ||
      ((state & TIMER_STATE.externalStep) !== 0 && (state & TIMER_STATE.start) !== 0)
    ) {
      next |= TIMER_STATE.countStage3;
    }
    if ((state & TIMER_STATE.countStage3) !== 0) next |= TIMER_STATE.count;
    if ((state & TIMER_STATE.forceLoadControl) !== 0) next |= TIMER_STATE.loadStage1;
    if ((state & TIMER_STATE.loadStage1) !== 0) next |= TIMER_STATE.load;
    if ((state & TIMER_STATE.oneShotControl) !== 0) next |= TIMER_STATE.oneShotStage0;
    if ((state & TIMER_STATE.oneShotStage0) !== 0) next |= TIMER_STATE.oneShot;
    return next;
  }

  private updateOutput(): void {
    this.toggleStateHigh = !this.toggleStateHigh;
    this.underflowPulseActive = true;
  }
}
