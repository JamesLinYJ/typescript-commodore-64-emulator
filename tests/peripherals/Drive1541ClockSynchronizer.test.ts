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

class CountingCycleMachine implements Drive1541ClockedMachine {
  elapsedCycles = 0;
  singleCycleCalls = 0;
  batchCalls = 0;

  clockCycle(): number {
    this.singleCycleCalls += 1;
    this.elapsedCycles += 1;
    return 1;
  }

  clockCycles(cycles: number): number {
    this.batchCalls += 1;
    this.elapsedCycles += cycles;
    return cycles;
  }

  resetTiming(): void {
    this.elapsedCycles = 0;
  }
}

describe('Drive1541ClockSynchronizer', () => {
  it('converts one PAL C64 clock-second into exactly one million target drive cycles', () => {
    const machine = new CountingCycleMachine();
    const synchronizer = new Drive1541ClockSynchronizer(machine);
    synchronizer.advanceHostCycles(PAL_VIDEO_STANDARD.timing.processorClockHz);

    expect(synchronizer.targetCycles).toBe(1_000_000);
    expect(machine.elapsedCycles).toBe(1_000_000);
    expect(synchronizer.leadCycles).toBe(0);
  });

  it('retains fractional host cycles without running ahead of the target clock', () => {
    const machine = new CountingCycleMachine();
    const synchronizer = new Drive1541ClockSynchronizer(machine, 3_000_000);

    synchronizer.advanceHostCycles(2);
    expect(synchronizer.targetCycles).toBe(0);
    expect(machine.elapsedCycles).toBe(0);

    synchronizer.advanceHostCycles(1);
    expect(synchronizer.targetCycles).toBe(1);
    expect(machine.elapsedCycles).toBe(1);
    expect(synchronizer.leadCycles).toBe(0);

    synchronizer.advanceHostCycles(6);
    expect(synchronizer.targetCycles).toBe(3);
    expect(machine.elapsedCycles).toBe(3);
    expect(synchronizer.leadCycles).toBe(0);
  });

  it('resets both rational-clock state and the drive machine clock', () => {
    const machine = new CountingCycleMachine();
    const synchronizer = new Drive1541ClockSynchronizer(machine);
    synchronizer.advanceHostCycles(20);
    expect(machine.elapsedCycles).toBeGreaterThan(0);

    synchronizer.resetClock();
    expect(synchronizer.targetCycles).toBe(0);
    expect(synchronizer.leadCycles).toBe(0);
    expect(machine.elapsedCycles).toBe(0);
  });

  it('keeps the fixed single-cycle phase path exactly equivalent to the checked batch API', () => {
    const singleMachine = new CountingCycleMachine();
    const batchMachine = new CountingCycleMachine();
    const single = new Drive1541ClockSynchronizer(singleMachine);
    const batch = new Drive1541ClockSynchronizer(batchMachine);
    const hostCycles = 100_000;

    for (let cycle = 0; cycle < hostCycles; cycle += 1) single.advanceHostCycle();
    batch.advanceHostCycles(hostCycles);

    expect(single.targetCycles).toBe(batch.targetCycles);
    expect(single.phaseRemainder).toBe(batch.phaseRemainder);
    expect(singleMachine.elapsedCycles).toBe(batchMachine.elapsedCycles);
    expect(singleMachine.singleCycleCalls).toBe(single.targetCycles);
    expect(singleMachine.batchCalls).toBe(0);
    expect(batchMachine.batchCalls).toBe(1);
  });
});
