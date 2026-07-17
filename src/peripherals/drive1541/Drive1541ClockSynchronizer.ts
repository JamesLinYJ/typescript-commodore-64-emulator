// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 与主机时钟同步
//
//   文件:       Drive1541ClockSynchronizer.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { C64ClockedPeripheral } from '../../core/C64Machine';
import { PAL_VIDEO_STANDARD } from '../../video/palVideoStandard';

export const DRIVE_1541_CLOCK = {
  processorClockHz: 1_000_000,
} as const;

export interface Drive1541ClockedMachine {
  readonly elapsedCycles: number;
  executeInstruction(checkBreakpoints?: boolean): number;
  resetTiming(): void;
}

/**
 * 用整数有理数把 PAL C64 的 985248 Hz 时钟转换到 1541 的 1 MHz 时钟域。
 *
 * 驱动器 CPU 只能在指令边界停下，所以实际执行位置允许最多领先一条指令；累计目标时钟
 * 始终保持精确，后续主机周期会自然吸收该领先量，而不会用浮点数反复舍入。
 */
export class Drive1541ClockSynchronizer implements C64ClockedPeripheral {
  private hostClockRemainder = 0;
  private targetDriveCycles = 0;

  constructor(
    private readonly machine: Drive1541ClockedMachine,
    private readonly hostClockHz: number = PAL_VIDEO_STANDARD.timing.processorClockHz,
  ) {
    if (!Number.isSafeInteger(hostClockHz) || hostClockHz <= 0) {
      throw new RangeError('Host processor clock must be a positive safe integer in hertz.');
    }
  }

  get targetCycles(): number {
    return this.targetDriveCycles;
  }

  get leadCycles(): number {
    return this.machine.elapsedCycles - this.targetDriveCycles;
  }

  advanceHostCycles(cycles: number): void {
    if (!Number.isSafeInteger(cycles) || cycles < 0) {
      throw new RangeError('Host cycles must be a non-negative safe integer.');
    }
    const addedNumerator = cycles * DRIVE_1541_CLOCK.processorClockHz;
    const accumulatedNumerator = this.hostClockRemainder + addedNumerator;
    if (!Number.isSafeInteger(accumulatedNumerator)) {
      throw new RangeError(
        'Host clock interval is too large for exact synchronization arithmetic.',
      );
    }

    const generatedCycles = Math.floor(accumulatedNumerator / this.hostClockHz);
    this.hostClockRemainder = accumulatedNumerator % this.hostClockHz;
    this.targetDriveCycles += generatedCycles;
    if (!Number.isSafeInteger(this.targetDriveCycles)) {
      throw new RangeError('1541 target clock exceeded the safe integer range.');
    }

    while (this.machine.elapsedCycles < this.targetDriveCycles) {
      const elapsed = this.machine.executeInstruction(false);
      if (elapsed <= 0) {
        throw new Error('1541 CPU failed to advance while synchronizing its clock domain.');
      }
    }
  }

  resetClock(): void {
    this.hostClockRemainder = 0;
    this.targetDriveCycles = 0;
    this.machine.resetTiming();
  }
}
