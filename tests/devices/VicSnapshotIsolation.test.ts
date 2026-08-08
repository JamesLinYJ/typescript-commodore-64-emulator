// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 公共快照隔离回归
//
//   文件:       VicSnapshotIsolation.test.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { VicBadLineController, type VicBadLineCycle } from '../../src/devices/VicBadLineController';
import {
  VicCycleSequencer,
  type VicCycleResult,
  type VicCycleSignals,
} from '../../src/devices/VicCycleSequencer';
import { VicII } from '../../src/devices/VicII';
import type { VicMemoryBus } from '../../src/devices/VicMemoryBus';
import { VIC_REGISTER, VIC_SCREEN_CONTROL_1_BIT } from '../../src/devices/vicRegisters';
import { PAL_VIC_TIMING } from '../../src/devices/VicTiming';

const TEST_VIC_MEMORY: VicMemoryBus = {
  cpuDataBusValue: 0xff,
  readVicByte: () => 0xff,
  readVicColor: () => 0x0f,
};

const INACTIVE_CYCLE_SIGNALS: VicCycleSignals = {
  displayEnabled: false,
  spriteEnableMask: 0,
  spriteVerticalExpansionMask: 0,
  verticalScroll: 0,
  spriteY: () => 0,
};

function advanceSequencerTo(
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

function advanceVicTo(vic: VicII, rasterLine: number, cycle: number): VicCycleResult {
  const maximumCycles = PAL_VIC_TIMING.rasterLineCount * PAL_VIC_TIMING.cyclesPerRasterLine;
  for (let elapsed = 0; elapsed < maximumCycles; elapsed += 1) {
    const result = vic.tickCycle(TEST_VIC_MEMORY);
    if (result.rasterLine === rasterLine && result.cycle === cycle) return result;
  }
  throw new Error(`VIC-II did not reach raster ${rasterLine}, cycle ${cycle}.`);
}

describe('VIC-II public snapshot isolation', () => {
  it('keeps bad-line results and matrix accesses detached across ticks', () => {
    const controller = new VicBadLineController();
    let firstMatrixCycle: VicBadLineCycle | undefined;

    for (let cycle = 1; cycle <= PAL_VIC_TIMING.fetch.matrixFirstCycle; cycle += 1) {
      firstMatrixCycle = controller.tick({
        cycle,
        displayEnabled: true,
        frameStarted: cycle === 1,
        lineStarted: cycle === 1,
        rasterLine: PAL_VIC_TIMING.badLine.firstRasterLine,
        verticalScroll: 0,
      });
    }
    const secondMatrixCycle = controller.tick({
      cycle: PAL_VIC_TIMING.fetch.matrixFirstCycle + 1,
      displayEnabled: true,
      frameStarted: false,
      lineStarted: false,
      rasterLine: PAL_VIC_TIMING.badLine.firstRasterLine,
      verticalScroll: 0,
    });

    expect(firstMatrixCycle).toBeDefined();
    expect(firstMatrixCycle).not.toBe(secondMatrixCycle);
    expect(firstMatrixCycle?.matrixAccess).toEqual({ column: 0, source: 'videoMemory' });
    expect(secondMatrixCycle.matrixAccess).toEqual({ column: 1, source: 'videoMemory' });
    expect(firstMatrixCycle?.matrixAccess).not.toBe(secondMatrixCycle.matrixAccess);
  });

  it('keeps sequencer results and nested cycle data detached across ticks', () => {
    const sequencer = new VicCycleSequencer();
    const activeSignals: VicCycleSignals = {
      ...INACTIVE_CYCLE_SIGNALS,
      displayEnabled: true,
    };
    const first = advanceSequencerTo(
      sequencer,
      activeSignals,
      PAL_VIC_TIMING.badLine.firstRasterLine,
      PAL_VIC_TIMING.fetch.matrixFirstCycle,
    );
    const firstOffsets = first.spriteDataOffsets;
    const firstMatrixAccess = first.matrixAccess;
    const second = sequencer.tick(activeSignals);

    expect(first).not.toBe(second);
    expect(firstOffsets).not.toBe(second.spriteDataOffsets);
    expect(firstMatrixAccess).not.toBe(second.matrixAccess);
    expect(first).toMatchObject({
      cycle: PAL_VIC_TIMING.fetch.matrixFirstCycle,
      matrixAccess: { column: 0, source: 'videoMemory' },
    });
    expect(second).toMatchObject({
      cycle: PAL_VIC_TIMING.fetch.matrixFirstCycle + 1,
      matrixAccess: { column: 1, source: 'videoMemory' },
    });
  });

  it('keeps VicII cycle and raster-line snapshots detached from later work', () => {
    const vic = new VicII();
    vic.write(VIC_REGISTER.screenControl1, VIC_SCREEN_CONTROL_1_BIT.displayEnable);
    const firstCycle = advanceVicTo(
      vic,
      PAL_VIC_TIMING.badLine.firstRasterLine,
      PAL_VIC_TIMING.fetch.matrixFirstCycle,
    );
    const firstOffsets = firstCycle.spriteDataOffsets;
    const firstMatrixAccess = firstCycle.matrixAccess;
    const secondCycle = vic.tickCycle(TEST_VIC_MEMORY);

    expect(firstCycle).not.toBe(secondCycle);
    expect(firstOffsets).not.toBe(secondCycle.spriteDataOffsets);
    expect(firstMatrixAccess).not.toBe(secondCycle.matrixAccess);
    expect(firstCycle).toMatchObject({
      cycle: PAL_VIC_TIMING.fetch.matrixFirstCycle,
      matrixAccess: { column: 0, source: 'videoMemory' },
    });
    expect(secondCycle).toMatchObject({
      cycle: PAL_VIC_TIMING.fetch.matrixFirstCycle + 1,
      matrixAccess: { column: 1, source: 'videoMemory' },
    });

    const firstLine = vic.captureRasterLineState();
    const originalBorderColor = firstLine.borderColors[0];
    const originalGraphicsByte = firstLine.fetchState.graphics[0];
    const originalPixel = firstLine.pixels[0];
    firstLine.borderColors[0] = (originalBorderColor ?? 0) ^ 0xffffffff;
    firstLine.fetchState.graphics[0] = (originalGraphicsByte ?? 0) ^ 0xff;
    firstLine.pixels[0] = (originalPixel ?? 0) ^ 0xffffffff;

    const secondLine = vic.captureRasterLineState();
    expect(secondLine).not.toBe(firstLine);
    expect(secondLine.fetchState).not.toBe(firstLine.fetchState);
    expect(secondLine.borderColors).not.toBe(firstLine.borderColors);
    expect(secondLine.borderPixelMasks).not.toBe(firstLine.borderPixelMasks);
    expect(secondLine.fetchState.colorMatrix).not.toBe(firstLine.fetchState.colorMatrix);
    expect(secondLine.fetchState.graphics).not.toBe(firstLine.fetchState.graphics);
    expect(secondLine.fetchState.screenMatrix).not.toBe(firstLine.fetchState.screenMatrix);
    expect(secondLine.fetchState.spriteData).not.toBe(firstLine.fetchState.spriteData);
    expect(secondLine.fetchState.spritePointers).not.toBe(firstLine.fetchState.spritePointers);
    expect(secondLine.pixels).not.toBe(firstLine.pixels);
    expect(secondLine.borderColors[0]).toBe(originalBorderColor);
    expect(secondLine.fetchState.graphics[0]).toBe(originalGraphicsByte);
    expect(secondLine.pixels[0]).toBe(originalPixel);
  });
});
