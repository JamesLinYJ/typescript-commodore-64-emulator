// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 半周期总线计划测试
//
//   文件:       VicBusSchedule.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { vicBusScheduleForCycle } from '../../src/devices/VicBusSchedule';
import { PAL_VIC_TIMING } from '../../src/devices/VicTiming';

describe('VIC-II PAL bus schedule', () => {
  it('assigns one Phi1 fetch to every cycle and matrix fetches to cycles 15 through 54', () => {
    const schedule = Array.from({ length: PAL_VIC_TIMING.cyclesPerRasterLine }, (_, cycle) =>
      vicBusScheduleForCycle(cycle + 1),
    );

    expect(schedule.every((entry) => entry.phi1.phase === 'phi1')).toBe(true);
    expect(
      schedule.filter((entry) => entry.phi2?.kind === 'matrix').map((entry) => entry.cycle),
    ).toEqual(Array.from({ length: 40 }, (_, index) => index + 15));
  });

  it('derives all wrapped sprite pointer and data slots from the sprite index', () => {
    const expected = [
      [58, 59],
      [60, 61],
      [62, 63],
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
      [9, 10],
    ] as const;

    for (let spriteIndex = 0; spriteIndex < expected.length; spriteIndex += 1) {
      const cycles = expected[spriteIndex];
      if (!cycles) throw new Error(`Missing expected schedule for sprite ${spriteIndex}.`);
      const pointerAndFirstByte = vicBusScheduleForCycle(cycles[0]);
      const remainingBytes = vicBusScheduleForCycle(cycles[1]);

      expect(pointerAndFirstByte.phi1).toEqual({
        kind: 'spritePointer',
        phase: 'phi1',
        spriteIndex,
      });
      expect(pointerAndFirstByte.phi2).toEqual({
        byteIndex: 0,
        kind: 'spriteData',
        phase: 'phi2',
        spriteIndex,
      });
      expect(remainingBytes.phi1).toEqual({
        byteIndex: 1,
        kind: 'spriteData',
        phase: 'phi1',
        spriteIndex,
      });
      expect(remainingBytes.phi2).toEqual({
        byteIndex: 2,
        kind: 'spriteData',
        phase: 'phi2',
        spriteIndex,
      });
    }
  });

  it('uses refresh, graphics, and idle Phi1 slots between sprite windows', () => {
    expect(vicBusScheduleForCycle(11).phi1.kind).toBe('refresh');
    expect(vicBusScheduleForCycle(15).phi1.kind).toBe('refresh');
    expect(vicBusScheduleForCycle(16).phi1.kind).toBe('graphics');
    expect(vicBusScheduleForCycle(55).phi1.kind).toBe('graphics');
    expect(vicBusScheduleForCycle(56).phi1.kind).toBe('idle');
    expect(vicBusScheduleForCycle(57).phi1.kind).toBe('idle');
  });

  it('rejects cycles outside the selected PAL model', () => {
    expect(() => vicBusScheduleForCycle(0)).toThrow(RangeError);
    expect(() => vicBusScheduleForCycle(64)).toThrow(RangeError);
    expect(() => vicBusScheduleForCycle(1.5)).toThrow(RangeError);
  });
});
