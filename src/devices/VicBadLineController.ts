// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 动态坏线与总线取得
//
//   文件:       VicBadLineController.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { PAL_VIC_TIMING, type VicTiming } from './VicTiming';

export const VIC_MATRIX_ACCESS_SOURCE = {
  cpuDataBus: 'cpuDataBus',
  videoMemory: 'videoMemory',
} as const;

export type VicMatrixAccessSource =
  (typeof VIC_MATRIX_ACCESS_SOURCE)[keyof typeof VIC_MATRIX_ACCESS_SOURCE];

export interface VicMatrixAccess {
  readonly column: number;
  readonly source: VicMatrixAccessSource;
}

export interface VicBadLineSignals {
  readonly cycle: number;
  readonly displayEnabled: boolean;
  readonly frameStarted: boolean;
  readonly lineStarted: boolean;
  readonly rasterLine: number;
  readonly verticalScroll: number;
}

export interface VicBadLineCycle {
  readonly active: boolean;
  readonly aecLow: boolean;
  readonly baLow: boolean;
  readonly condition: boolean;
  readonly enterDisplayState: boolean;
  readonly lateVideoCounterReloadColumn: number | undefined;
  readonly matrixAccess: VicMatrixAccess | undefined;
  readonly resetRowCounter: boolean;
}

export interface VicBadLineCycleBuffer {
  active: boolean;
  aecLow: boolean;
  baLow: boolean;
  condition: boolean;
  enterDisplayState: boolean;
  lateVideoCounterReloadColumn: number | undefined;
  matrixAccess: VicMatrixAccess | undefined;
  resetRowCounter: boolean;
}

/**
 * VIC-II 的坏线条件与已经启动的矩阵 DMA 是两个不同状态。
 *
 * `$D011` 可以在一条光栅线中多次建立或撤销坏线条件；一旦 DMA 已越过周期 14，撤销
 * 条件不会收回已经发出的 BA。动态启动时 BA 先拉低，AEC 三周期后才拉低，期间 VIC
 * 仍尝试 C-access 并从未驱动的八位总线读到 `$FF`。
 */
export class VicBadLineController {
  private readonly cpuDataBusMatrixAccesses: readonly VicMatrixAccess[];
  private readonly videoMemoryMatrixAccesses: readonly VicMatrixAccess[];
  private allowBadLines = false;
  private badLineActive = false;
  private conditionWasActive = false;
  private displayStateEnteredThisLine = false;
  private dmaStartCycle: number | undefined;

  constructor(private readonly timing: VicTiming = PAL_VIC_TIMING) {
    this.cpuDataBusMatrixAccesses = createMatrixAccesses(
      timing,
      VIC_MATRIX_ACCESS_SOURCE.cpuDataBus,
    );
    this.videoMemoryMatrixAccesses = createMatrixAccesses(
      timing,
      VIC_MATRIX_ACCESS_SOURCE.videoMemory,
    );
  }

  get active(): boolean {
    return this.badLineActive;
  }

  reset(): void {
    this.allowBadLines = false;
    this.badLineActive = false;
    this.conditionWasActive = false;
    this.displayStateEnteredThisLine = false;
    this.dmaStartCycle = undefined;
  }

  tick(signals: VicBadLineSignals): VicBadLineCycle {
    const result = createBadLineCycleBuffer();
    this.tickInto(signals, result);
    if (result.matrixAccess !== undefined) result.matrixAccess = { ...result.matrixAccess };
    return result;
  }

  /** 将单周期结果写入调用方专有缓冲；该缓冲不是可长期保留的快照。 */
  tickInto(signals: VicBadLineSignals, result: VicBadLineCycleBuffer): void {
    if (signals.frameStarted) this.allowBadLines = false;
    if (signals.lineStarted) this.beginRasterLine();

    // DEN 只需在光栅线 $30 的任一完整周期为 1，本帧后续行就允许产生坏线条件。
    if (signals.rasterLine === this.timing.badLine.firstRasterLine && signals.displayEnabled) {
      this.allowBadLines = true;
    }

    const condition = this.isBadLineCondition(signals.rasterLine, signals.verticalScroll);
    const conditionStarted = condition && !this.conditionWasActive;
    const conditionEnded = !condition && this.conditionWasActive;
    let enterDisplayState = false;
    let lateVideoCounterReloadColumn: number | undefined;

    if (conditionStarted) {
      this.badLineActive = true;
      if (!this.displayStateEnteredThisLine) {
        enterDisplayState = true;
        this.displayStateEnteredThisLine = true;
      }

      if (signals.cycle <= this.timing.fetch.matrixLastCycle) {
        const requestedStartCycle = Math.max(signals.cycle, this.timing.badLine.baFirstCycle);
        this.dmaStartCycle ??= requestedStartCycle;

        // 周期 14 的常规 VCBASE->VC 已经结束后，动态坏线必须在当前位置重新装入 VC。
        // 矩阵窗口结束后的坏线只影响显示态与 RC，不能凭空重开已经结束的 DMA。
        if (signals.cycle > this.timing.fetch.videoCounterReloadCycle) {
          lateVideoCounterReloadColumn = this.matrixColumnForCycle(signals.cycle);
        }
      }
    }

    // 在周期 14 的采样点之前撤销条件会产生 Linecrunch：显示态保留，但没有矩阵 DMA，
    // RC 也不会清零。周期 15 起，已经启动的 DMA 必须继续到周期 54。
    if (conditionEnded && signals.cycle <= this.timing.fetch.videoCounterReloadCycle) {
      this.badLineActive = false;
      this.dmaStartCycle = undefined;
    }

    const matrixAccess = this.matrixAccessForCycle(signals.cycle);
    const baLow = this.isDmaBusRequestCycle(signals.cycle);
    const aecLow =
      baLow &&
      this.dmaStartCycle !== undefined &&
      signals.cycle >= this.dmaStartCycle + this.busAcquisitionCycleCount;
    const resetRowCounter =
      signals.cycle === this.timing.fetch.videoCounterReloadCycle && condition;

    this.conditionWasActive = condition;
    result.active = this.badLineActive;
    result.aecLow = aecLow;
    result.baLow = baLow;
    result.condition = condition;
    result.enterDisplayState = enterDisplayState;
    result.lateVideoCounterReloadColumn = lateVideoCounterReloadColumn;
    result.matrixAccess = matrixAccess;
    result.resetRowCounter = resetRowCounter;
  }

  private get busAcquisitionCycleCount(): number {
    return this.timing.fetch.matrixFirstCycle - this.timing.badLine.baFirstCycle;
  }

  private beginRasterLine(): void {
    this.badLineActive = false;
    this.conditionWasActive = false;
    this.displayStateEnteredThisLine = false;
    this.dmaStartCycle = undefined;
  }

  private isBadLineCondition(rasterLine: number, verticalScroll: number): boolean {
    return (
      this.allowBadLines &&
      rasterLine >= this.timing.badLine.firstRasterLine &&
      rasterLine <= this.timing.badLine.lastRasterLine &&
      (rasterLine & 0x07) === verticalScroll
    );
  }

  private isDmaBusRequestCycle(cycle: number): boolean {
    return (
      this.dmaStartCycle !== undefined &&
      cycle >= this.dmaStartCycle &&
      cycle <= this.timing.badLine.baLastCycle
    );
  }

  private matrixAccessForCycle(cycle: number): VicMatrixAccess | undefined {
    if (
      this.dmaStartCycle === undefined ||
      cycle < Math.max(this.dmaStartCycle, this.timing.fetch.matrixFirstCycle) ||
      cycle > this.timing.fetch.matrixLastCycle
    ) {
      return undefined;
    }
    const column = this.matrixColumnForCycle(cycle);
    return cycle < this.dmaStartCycle + this.busAcquisitionCycleCount
      ? this.cpuDataBusMatrixAccesses[column]
      : this.videoMemoryMatrixAccesses[column];
  }

  private matrixColumnForCycle(cycle: number): number {
    return Math.max(
      0,
      Math.min(
        this.timing.fetch.matrixLastCycle - this.timing.fetch.matrixFirstCycle,
        cycle - this.timing.fetch.matrixFirstCycle,
      ),
    );
  }
}

function createBadLineCycleBuffer(): VicBadLineCycleBuffer {
  return {
    active: false,
    aecLow: false,
    baLow: false,
    condition: false,
    enterDisplayState: false,
    lateVideoCounterReloadColumn: undefined,
    matrixAccess: undefined,
    resetRowCounter: false,
  };
}

function createMatrixAccesses(
  timing: VicTiming,
  source: VicMatrixAccessSource,
): readonly VicMatrixAccess[] {
  const count = timing.fetch.matrixLastCycle - timing.fetch.matrixFirstCycle + 1;
  return Object.freeze(
    Array.from({ length: count }, (_, column) => Object.freeze({ column, source })),
  );
}
