// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 主机时钟同步测试
//
//   文件:       Drive1541ClockSynchronizer.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  Drive1541ClockSynchronizer,
  type Drive1541ClockedMachine,
} from '../../src/peripherals/drive1541/Drive1541ClockSynchronizer';
import { PAL_VIDEO_STANDARD } from '../../src/video/palVideoStandard';

class FixedInstructionMachine implements Drive1541ClockedMachine {
  elapsedCycles = 0;

  constructor(private readonly instructionCycles: number) {}

  executeInstruction(): number {
    this.elapsedCycles += this.instructionCycles;
    return this.instructionCycles;
  }

  resetTiming(): void {
    this.elapsedCycles = 0;
  }
}

describe('Drive1541ClockSynchronizer', () => {
  it('converts one PAL C64 clock-second into exactly one million target drive cycles', () => {
    const machine = new FixedInstructionMachine(1_000);
    const synchronizer = new Drive1541ClockSynchronizer(machine);
    synchronizer.advanceHostCycles(PAL_VIDEO_STANDARD.timing.processorClockHz);

    expect(synchronizer.targetCycles).toBe(1_000_000);
    expect(machine.elapsedCycles).toBe(1_000_000);
    expect(synchronizer.leadCycles).toBe(0);
  });

  it('retains fractional host cycles and bounds execution lead to one instruction', () => {
    const machine = new FixedInstructionMachine(3);
    const synchronizer = new Drive1541ClockSynchronizer(machine, 3_000_000);

    synchronizer.advanceHostCycles(2);
    expect(synchronizer.targetCycles).toBe(0);
    expect(machine.elapsedCycles).toBe(0);

    synchronizer.advanceHostCycles(1);
    expect(synchronizer.targetCycles).toBe(1);
    expect(machine.elapsedCycles).toBe(3);
    expect(synchronizer.leadCycles).toBe(2);

    synchronizer.advanceHostCycles(6);
    expect(synchronizer.targetCycles).toBe(3);
    expect(synchronizer.leadCycles).toBe(0);
  });

  it('resets both rational-clock state and the drive machine clock', () => {
    const machine = new FixedInstructionMachine(2);
    const synchronizer = new Drive1541ClockSynchronizer(machine);
    synchronizer.advanceHostCycles(20);
    expect(machine.elapsedCycles).toBeGreaterThan(0);

    synchronizer.resetClock();
    expect(synchronizer.targetCycles).toBe(0);
    expect(synchronizer.leadCycles).toBe(0);
    expect(machine.elapsedCycles).toBe(0);
  });
});
