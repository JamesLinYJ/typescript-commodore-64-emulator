// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 周期时序测试
//
//   文件:       VicCycleSequencer.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  VicCycleSequencer,
  type VicCycleResult,
  type VicCycleSignals,
} from '../../src/devices/VicCycleSequencer';
import { PAL_VIC_TIMING } from '../../src/devices/VicTiming';

class MutableVicSignals implements VicCycleSignals {
  displayEnabled = false;
  spriteEnableMask = 0;
  spriteVerticalExpansionMask = 0;
  verticalScroll = 0;
  readonly spriteYPositions = new Uint8Array(8);

  spriteY(spriteIndex: number): number {
    return this.spriteYPositions[spriteIndex] ?? 0;
  }
}

function advanceTo(
  sequencer: VicCycleSequencer,
  signals: VicCycleSignals,
  rasterLine: number,
  cycle: number,
): VicCycleResult {
  const maximumCycles = PAL_VIC_TIMING.rasterLineCount * PAL_VIC_TIMING.cyclesPerRasterLine;
  for (let elapsed = 0; elapsed < maximumCycles; elapsed += 1) {
    const result = sequencer.tick(signals);
    if (result.rasterLine === rasterLine && result.cycle === cycle) return result;
  }
  throw new Error(`VIC-II did not reach raster ${rasterLine}, cycle ${cycle}.`);
}

describe('VicCycleSequencer', () => {
  it('advances through all 63 PAL cycles and 312 raster lines', () => {
    const sequencer = new VicCycleSequencer();
    const signals = new MutableVicSignals();
    let result: VicCycleResult | undefined;

    for (
      let elapsed = 0;
      elapsed < PAL_VIC_TIMING.rasterLineCount * PAL_VIC_TIMING.cyclesPerRasterLine;
      elapsed += 1
    ) {
      result = sequencer.tick(signals);
    }

    expect(result).toMatchObject({
      completedRasterLine: PAL_VIC_TIMING.rasterLineCount - 1,
      cycle: PAL_VIC_TIMING.cyclesPerRasterLine,
      rasterLine: PAL_VIC_TIMING.rasterLineCount - 1,
    });
    expect(sequencer.tick(signals)).toMatchObject({
      completedRasterLine: undefined,
      cycle: 1,
      frameStarted: true,
      lineStarted: true,
      rasterLine: 0,
    });
  });

  it('asserts BA before AEC takes the Phi2 bus on an enabled bad line', () => {
    const sequencer = new VicCycleSequencer();
    const signals = new MutableVicSignals();
    signals.displayEnabled = true;
    signals.verticalScroll = 0;

    const before = advanceTo(sequencer, signals, 0x30, 11);
    const first = sequencer.tick(signals);
    const beforeAec = advanceTo(sequencer, signals, 0x30, 14);
    const firstAec = sequencer.tick(signals);
    const last = advanceTo(sequencer, signals, 0x30, 54);
    const after = sequencer.tick(signals);

    expect(before).toMatchObject({ aecLow: false, baLow: false, badLine: true });
    expect(first).toMatchObject({ aecLow: false, baLow: true, badLine: true, cycle: 12 });
    expect(beforeAec).toMatchObject({ aecLow: false, baLow: true, cycle: 14 });
    expect(firstAec).toMatchObject({ aecLow: true, baLow: true, cycle: 15 });
    expect(last).toMatchObject({ aecLow: true, baLow: true, badLine: true, cycle: 54 });
    expect(after).toMatchObject({ aecLow: false, baLow: false, badLine: true, cycle: 55 });
  });

  it('does not create later bad lines when DEN was never enabled on raster $30', () => {
    const sequencer = new VicCycleSequencer();
    const signals = new MutableVicSignals();
    advanceTo(sequencer, signals, 0x31, 1);
    signals.displayEnabled = true;

    const candidate = advanceTo(sequencer, signals, 0x38, 20);

    expect(candidate.badLine).toBe(false);
    expect(candidate.baLow).toBe(false);
  });

  it('uses the five-cycle wrapped BA window for sprite DMA', () => {
    const sequencer = new VicCycleSequencer();
    const signals = new MutableVicSignals();
    signals.spriteEnableMask = 1 << 3;
    signals.spriteYPositions[3] = 0;

    expect(advanceTo(sequencer, signals, 0, 60)).toMatchObject({ aecLow: false, baLow: false });
    expect(sequencer.tick(signals)).toMatchObject({ aecLow: false, baLow: true, cycle: 61 });
    expect(advanceTo(sequencer, signals, 0, 63)).toMatchObject({ aecLow: false, baLow: true });
    expect(sequencer.tick(signals)).toMatchObject({ aecLow: true, baLow: true, cycle: 1 });
    expect(sequencer.tick(signals)).toMatchObject({ aecLow: true, baLow: true, cycle: 2 });
    expect(sequencer.tick(signals)).toMatchObject({ aecLow: false, baLow: false, cycle: 3 });
  });

  it('ends unexpanded sprite DMA after 21 rows and doubles expanded DMA duration', () => {
    const unexpanded = new VicCycleSequencer();
    const expanded = new VicCycleSequencer();
    const normalSignals = new MutableVicSignals();
    const expandedSignals = new MutableVicSignals();
    normalSignals.spriteEnableMask = 0x01;
    expandedSignals.spriteEnableMask = 0x01;
    expandedSignals.spriteVerticalExpansionMask = 0x01;

    expect(advanceTo(unexpanded, normalSignals, 20, 16).spriteDmaMask & 0x01).toBe(0x01);
    expect(advanceTo(unexpanded, normalSignals, 21, 16).spriteDmaMask & 0x01).toBe(0x00);

    expect(advanceTo(expanded, expandedSignals, 21, 16).spriteDmaMask & 0x01).toBe(0x01);
    expect(advanceTo(expanded, expandedSignals, 42, 16).spriteDmaMask & 0x01).toBe(0x00);
  });

  it('restores the expansion flip-flop when D017 is cleared after cycle 56', () => {
    const sequencer = new VicCycleSequencer();
    const signals = new MutableVicSignals();
    const spriteBit = 0x01;
    signals.spriteEnableMask = spriteBit;
    signals.spriteVerticalExpansionMask = spriteBit;

    advanceTo(sequencer, signals, 0, 57);
    signals.spriteVerticalExpansionMask = 0;
    sequencer.writeSpriteVerticalExpansionRegister(0);

    expect(advanceTo(sequencer, signals, 20, 16).spriteDmaMask & spriteBit).toBe(spriteBit);
    expect(advanceTo(sequencer, signals, 21, 16).spriteDmaMask & spriteBit).toBe(0);
  });

  it('latches sprite display at cycle 58 until the active DMA has finished', () => {
    const sequencer = new VicCycleSequencer();
    const signals = new MutableVicSignals();
    const spriteBit = 0x01;
    const spriteY = 20;
    signals.spriteEnableMask = spriteBit;
    signals.spriteYPositions[0] = spriteY;

    expect(advanceTo(sequencer, signals, spriteY, 57).spriteDisplayMask & spriteBit).toBe(0);
    expect(sequencer.tick(signals).spriteDisplayMask & spriteBit).toBe(spriteBit);

    signals.spriteEnableMask = 0;
    expect(advanceTo(sequencer, signals, spriteY + 1, 10).spriteDisplayMask & spriteBit).toBe(
      spriteBit,
    );
    expect(advanceTo(sequencer, signals, spriteY + 21, 10).spriteDisplayMask & spriteBit).toBe(
      spriteBit,
    );
    expect(advanceTo(sequencer, signals, spriteY + 21, 58).spriteDisplayMask & spriteBit).toBe(0);
  });
});
