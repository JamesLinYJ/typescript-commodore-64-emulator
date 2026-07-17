// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 动态坏线控制器测试
//
//   文件:       VicBadLineController.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  VIC_MATRIX_ACCESS_SOURCE,
  VicBadLineController,
  type VicBadLineCycle,
} from '../../src/devices/VicBadLineController';

interface MutableBadLineSignals {
  displayEnabled: boolean;
  rasterLine: number;
  verticalScroll: number;
}

function tick(
  controller: VicBadLineController,
  signals: MutableBadLineSignals,
  cycle: number,
  options: {
    readonly frameStarted?: boolean;
    readonly lineStarted?: boolean;
  } = {},
): VicBadLineCycle {
  return controller.tick({
    cycle,
    displayEnabled: signals.displayEnabled,
    frameStarted: options.frameStarted ?? false,
    lineStarted: options.lineStarted ?? false,
    rasterLine: signals.rasterLine,
    verticalScroll: signals.verticalScroll,
  });
}

function runRasterLine(
  controller: VicBadLineController,
  signals: MutableBadLineSignals,
  lastCycle = 63,
): readonly VicBadLineCycle[] {
  const results: VicBadLineCycle[] = [];
  for (let cycle = 1; cycle <= lastCycle; cycle += 1) {
    results.push(tick(controller, signals, cycle, { lineStarted: cycle === 1 }));
  }
  return results;
}

function latchDisplayEnable(controller: VicBadLineController): void {
  const signals: MutableBadLineSignals = {
    displayEnabled: true,
    rasterLine: 0x30,
    verticalScroll: 1,
  };
  tick(controller, signals, 1, { frameStarted: true, lineStarted: true });
}

describe('VicBadLineController', () => {
  it('requests BA three cycles before the first matrix DMA access', () => {
    const controller = new VicBadLineController();
    const signals: MutableBadLineSignals = {
      displayEnabled: true,
      rasterLine: 0x30,
      verticalScroll: 0,
    };
    const results = runRasterLine(controller, signals, 55);

    expect(results[10]).toMatchObject({ aecLow: false, baLow: false, condition: true });
    expect(results[11]).toMatchObject({ aecLow: false, baLow: true });
    expect(results[13]).toMatchObject({ aecLow: false, baLow: true, resetRowCounter: true });
    expect(results[14]).toMatchObject({
      aecLow: true,
      baLow: true,
      matrixAccess: { column: 0, source: VIC_MATRIX_ACCESS_SOURCE.videoMemory },
    });
    expect(results[53]).toMatchObject({
      aecLow: true,
      baLow: true,
      matrixAccess: { column: 39, source: VIC_MATRIX_ACCESS_SOURCE.videoMemory },
    });
    expect(results[54]).toMatchObject({ aecLow: false, baLow: false, matrixAccess: undefined });
  });

  it('keeps display state but cancels DMA when the condition ends by cycle 14', () => {
    const controller = new VicBadLineController();
    latchDisplayEnable(controller);
    const signals: MutableBadLineSignals = {
      displayEnabled: false,
      rasterLine: 0x38,
      verticalScroll: 1,
    };

    tick(controller, signals, 1, { lineStarted: true });
    for (let cycle = 2; cycle < 8; cycle += 1) tick(controller, signals, cycle);
    signals.verticalScroll = 0;
    const started = tick(controller, signals, 8);
    for (let cycle = 9; cycle < 14; cycle += 1) tick(controller, signals, cycle);
    signals.verticalScroll = 1;
    const cancelled = tick(controller, signals, 14);
    const firstMatrixCycle = tick(controller, signals, 15);

    expect(started).toMatchObject({ active: true, enterDisplayState: true });
    expect(cancelled).toMatchObject({
      active: false,
      baLow: false,
      condition: false,
      resetRowCounter: false,
    });
    expect(firstMatrixCycle.matrixAccess).toBeUndefined();
  });

  it('models three CPU-bus columns before a mid-line DMA takes ownership', () => {
    const controller = new VicBadLineController();
    latchDisplayEnable(controller);
    const signals: MutableBadLineSignals = {
      displayEnabled: false,
      rasterLine: 0x38,
      verticalScroll: 1,
    };

    for (let cycle = 1; cycle <= 20; cycle += 1) {
      tick(controller, signals, cycle, { lineStarted: cycle === 1 });
    }
    signals.verticalScroll = 0;
    const cycle21 = tick(controller, signals, 21);
    const cycle22 = tick(controller, signals, 22);
    const cycle23 = tick(controller, signals, 23);
    const cycle24 = tick(controller, signals, 24);

    expect(cycle21).toMatchObject({
      aecLow: false,
      baLow: true,
      enterDisplayState: true,
      lateVideoCounterReloadColumn: 6,
      matrixAccess: { column: 6, source: VIC_MATRIX_ACCESS_SOURCE.cpuDataBus },
    });
    expect(cycle22.matrixAccess).toEqual({
      column: 7,
      source: VIC_MATRIX_ACCESS_SOURCE.cpuDataBus,
    });
    expect(cycle23.matrixAccess).toEqual({
      column: 8,
      source: VIC_MATRIX_ACCESS_SOURCE.cpuDataBus,
    });
    expect(cycle24).toMatchObject({
      aecLow: true,
      baLow: true,
      matrixAccess: { column: 9, source: VIC_MATRIX_ACCESS_SOURCE.videoMemory },
    });
  });

  it('finishes an acquired DMA even after the bad-line condition is removed', () => {
    const controller = new VicBadLineController();
    latchDisplayEnable(controller);
    const signals: MutableBadLineSignals = {
      displayEnabled: false,
      rasterLine: 0x38,
      verticalScroll: 1,
    };

    for (let cycle = 1; cycle <= 20; cycle += 1) {
      tick(controller, signals, cycle, { lineStarted: cycle === 1 });
    }
    signals.verticalScroll = 0;
    for (let cycle = 21; cycle <= 24; cycle += 1) tick(controller, signals, cycle);
    signals.verticalScroll = 1;
    const removed = tick(controller, signals, 25);
    let finalDmaCycle = removed;
    for (let cycle = 26; cycle <= 54; cycle += 1) {
      finalDmaCycle = tick(controller, signals, cycle);
    }
    const afterDma = tick(controller, signals, 55);

    expect(removed).toMatchObject({ aecLow: true, baLow: true, condition: false });
    expect(finalDmaCycle).toMatchObject({
      aecLow: true,
      baLow: true,
      matrixAccess: { column: 39, source: VIC_MATRIX_ACCESS_SOURCE.videoMemory },
    });
    expect(afterDma).toMatchObject({ aecLow: false, baLow: false, matrixAccess: undefined });
  });

  it('does not reopen matrix DMA after its cycle window has ended', () => {
    const controller = new VicBadLineController();
    latchDisplayEnable(controller);
    const signals: MutableBadLineSignals = {
      displayEnabled: false,
      rasterLine: 0x38,
      verticalScroll: 1,
    };

    for (let cycle = 1; cycle <= 55; cycle += 1) {
      tick(controller, signals, cycle, { lineStarted: cycle === 1 });
    }
    signals.verticalScroll = 0;
    const lateStart = tick(controller, signals, 56);
    tick(controller, signals, 57);
    const rowCounterCycle = tick(controller, signals, 58);

    expect(lateStart).toMatchObject({
      active: true,
      baLow: false,
      enterDisplayState: true,
      lateVideoCounterReloadColumn: undefined,
      matrixAccess: undefined,
    });
    expect(rowCounterCycle).toMatchObject({ condition: true, matrixAccess: undefined });
  });

  it('latches DEN when it becomes enabled during any cycle of raster line $30', () => {
    const controller = new VicBadLineController();
    const signals: MutableBadLineSignals = {
      displayEnabled: false,
      rasterLine: 0x30,
      verticalScroll: 0,
    };

    tick(controller, signals, 1, { frameStarted: true, lineStarted: true });
    for (let cycle = 2; cycle < 20; cycle += 1) tick(controller, signals, cycle);
    signals.displayEnabled = true;
    expect(tick(controller, signals, 20).condition).toBe(true);

    signals.displayEnabled = false;
    signals.rasterLine = 0x38;
    expect(tick(controller, signals, 1, { lineStarted: true }).condition).toBe(true);
  });
});
