import { describe, expect, it } from 'vitest';

import { PalFrameScheduler } from '../../src/video/PalFrameScheduler';
import { PAL_VIC_TIMING } from '../../src/devices/VicTiming';
import { createC64System } from '../helpers/createTestSystem';

describe('PalFrameScheduler', () => {
  it('runs one complete PAL frame from VIC-II line-completion events', () => {
    const { cpu, memory } = createC64System();
    memory.ram.fill(0xea); // NOP stream
    const scheduler = new PalFrameScheduler(cpu, memory);
    const completedLines: number[] = [];

    scheduler.runFrame((rasterLine) => completedLines.push(rasterLine));

    expect(scheduler.machine.elapsedCycles).toBe(
      PAL_VIC_TIMING.cyclesPerRasterLine * PAL_VIC_TIMING.rasterLineCount,
    );
    expect(completedLines).toHaveLength(PAL_VIC_TIMING.rasterLineCount);
    expect(completedLines[0]).toBe(0);
    expect(completedLines.at(-1)).toBe(PAL_VIC_TIMING.rasterLineCount - 1);
  });
});
