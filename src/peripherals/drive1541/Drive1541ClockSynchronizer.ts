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
  clockCycle(checkBreakpoints?: boolean): number;
  clockCycles(cycles: number, checkBreakpoints?: boolean): number;
  resetTiming(): void;
}

/**
 * 用整数有理数把 PAL C64 的 985248 Hz 时钟转换到 1541 的 1 MHz 时钟域。
 *
 * 每个目标周期只推进一个 6502 总线周期，因而 IEC 读写不会从未来的主机时间点
 * 提前取样或发布。余数始终用整数累加，不会引入浮点漂移。
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

    const cyclesToRun = this.targetDriveCycles - this.machine.elapsedCycles;
    const elapsed = this.machine.clockCycles(cyclesToRun, false);
    if (elapsed !== cyclesToRun) {
      throw new Error(
        `1541 CPU clock batch advanced by ${elapsed} cycles instead of ${cyclesToRun}.`,
      );
    }
  }

  resetClock(): void {
    this.hostClockRemainder = 0;
    this.targetDriveCycles = 0;
    this.machine.resetTiming();
  }
}
