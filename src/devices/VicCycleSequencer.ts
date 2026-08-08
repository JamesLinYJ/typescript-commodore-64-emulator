// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 周期时序器
//
//   文件:       VicCycleSequencer.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { VIC_SPRITE_COUNT } from './vicRegisters';
import {
  VicBadLineController,
  type VicBadLineCycleBuffer,
  type VicMatrixAccess,
} from './VicBadLineController';
import {
  createVicBusSchedule,
  vicBusScheduleForCycle,
  type VicBusScheduleEntry,
} from './VicBusSchedule';
import { VicSpriteDma } from './VicSpriteDma';
import { PAL_VIC_TIMING, type VicTiming } from './VicTiming';

export interface VicCycleSignals {
  readonly displayEnabled: boolean;
  readonly spriteEnableMask: number;
  readonly spriteVerticalExpansionMask: number;
  readonly verticalScroll: number;
  spriteY(spriteIndex: number): number;
}

export interface VicCycleResult {
  readonly aecLow: boolean;
  readonly baLow: boolean;
  readonly badLine: boolean;
  readonly badLineCondition: boolean;
  readonly busSchedule: VicBusScheduleEntry;
  readonly completedRasterLine: number | undefined;
  readonly cycle: number;
  readonly enterDisplayState: boolean;
  readonly frameStarted: boolean;
  readonly lateVideoCounterReloadColumn: number | undefined;
  readonly lineStarted: boolean;
  readonly matrixAccess: VicMatrixAccess | undefined;
  readonly rasterLine: number;
  readonly resetRowCounter: boolean;
  readonly spriteDataOffsets: {
    readonly phi1: number | undefined;
    readonly phi2: number | undefined;
  };
  readonly spriteDisplayMask: number;
  readonly spriteDmaMask: number;
}

export interface VicCycleResultBuffer {
  aecLow: boolean;
  baLow: boolean;
  badLine: boolean;
  badLineCondition: boolean;
  busSchedule: VicBusScheduleEntry;
  completedRasterLine: number | undefined;
  cycle: number;
  enterDisplayState: boolean;
  frameStarted: boolean;
  lateVideoCounterReloadColumn: number | undefined;
  lineStarted: boolean;
  matrixAccess: VicMatrixAccess | undefined;
  rasterLine: number;
  resetRowCounter: boolean;
  spriteDataOffsets: {
    phi1: number | undefined;
    phi2: number | undefined;
  };
  spriteDisplayMask: number;
  spriteDmaMask: number;
}

interface MutableVicBadLineSignals {
  cycle: number;
  displayEnabled: boolean;
  frameStarted: boolean;
  lineStarted: boolean;
  rasterLine: number;
  verticalScroll: number;
}

// 此状态机只负责光栅位置、坏线、BA 和精灵 DMA 计数，不访问 C64 内存。
// 实际地址形成与数据锁存由 VicFetchPipeline 通过窄总线接口完成。
export class VicCycleSequencer {
  private readonly badLineController: VicBadLineController;
  private readonly busSchedule: readonly VicBusScheduleEntry[];
  private readonly badLineCycle: VicBadLineCycleBuffer = {
    active: false,
    aecLow: false,
    baLow: false,
    condition: false,
    enterDisplayState: false,
    lateVideoCounterReloadColumn: undefined,
    matrixAccess: undefined,
    resetRowCounter: false,
  };
  private readonly badLineSignals: MutableVicBadLineSignals = {
    cycle: 0,
    displayEnabled: false,
    frameStarted: false,
    lineStarted: false,
    rasterLine: 0,
    verticalScroll: 0,
  };
  private readonly spriteDma = Array.from({ length: VIC_SPRITE_COUNT }, () => new VicSpriteDma());
  private readonly spriteBaMaskByCycle: Uint8Array;
  private currentAecLow = false;
  private currentBaLow = false;
  private currentBadLine = false;
  private currentSpriteDisplayMask = 0;
  private currentSpriteDmaMask = 0;
  private cyclePosition = 0;
  private rasterPosition = 0;

  constructor(private readonly timing: VicTiming = PAL_VIC_TIMING) {
    this.badLineController = new VicBadLineController(timing);
    this.busSchedule = createVicBusSchedule(timing);
    this.spriteBaMaskByCycle = this.buildSpriteBaMaskTable();
  }

  get aecLow(): boolean {
    return this.currentAecLow;
  }

  get baLow(): boolean {
    return this.currentBaLow;
  }

  get badLine(): boolean {
    return this.currentBadLine;
  }

  get cycle(): number {
    return this.cyclePosition;
  }

  get rasterLine(): number {
    return this.rasterPosition;
  }

  get spriteDmaMask(): number {
    return this.currentSpriteDmaMask;
  }

  get spriteDisplayMask(): number {
    return this.currentSpriteDisplayMask;
  }

  writeSpriteVerticalExpansionRegister(value: number): void {
    const normalizedValue = value & 0xff;
    const applyMemoryCounterCrunch =
      this.cyclePosition === this.timing.sprite.memoryCounterCrunchCycle;

    for (let index = 0; index < this.spriteDma.length; index += 1) {
      if ((normalizedValue & (1 << index)) === 0) {
        this.spriteDma[index]?.clearVerticalExpansion(applyMemoryCounterCrunch);
      }
    }
  }

  tick(signals: VicCycleSignals): VicCycleResult {
    const result = createVicCycleResultBuffer();
    this.tickInto(signals, result);
    if (result.matrixAccess !== undefined) result.matrixAccess = { ...result.matrixAccess };
    return result;
  }

  /** 将单周期结果写入调用方专有缓冲；该缓冲不是可长期保留的快照。 */
  tickInto(signals: VicCycleSignals, result: VicCycleResultBuffer): void {
    let lineStarted = false;
    let frameStarted = false;

    if (this.cyclePosition === 0) {
      this.cyclePosition = 1;
      lineStarted = true;
      frameStarted = true;
    } else if (this.cyclePosition === this.timing.cyclesPerRasterLine) {
      this.cyclePosition = 1;
      this.rasterPosition = (this.rasterPosition + 1) % this.timing.rasterLineCount;
      lineStarted = true;
      frameStarted = this.rasterPosition === 0;
    } else {
      this.cyclePosition += 1;
    }

    // cyclePosition 在上面的状态机中已归一化为 1..cyclesPerRasterLine，内部热路径
    // 可直接索引预构建计划；公开查询函数仍保留完整的整数与范围校验。
    const busSchedule = this.busSchedule[this.cyclePosition - 1]!;
    const badLineSignals = this.badLineSignals;
    badLineSignals.cycle = this.cyclePosition;
    badLineSignals.displayEnabled = signals.displayEnabled;
    badLineSignals.frameStarted = frameStarted;
    badLineSignals.lineStarted = lineStarted;
    badLineSignals.rasterLine = this.rasterPosition;
    badLineSignals.verticalScroll = signals.verticalScroll;
    this.badLineController.tickInto(badLineSignals, this.badLineCycle);
    const badLineCycle = this.badLineCycle;
    this.currentBadLine = badLineCycle.active;
    this.updateSpriteDma(signals);
    this.consumeScheduledSpriteData(busSchedule, result.spriteDataOffsets);
    this.currentBaLow =
      badLineCycle.baLow ||
      (this.currentSpriteDmaMask & (this.spriteBaMaskByCycle[this.cyclePosition] ?? 0)) !== 0;
    // AEC 只在 VIC-II 真正占用 φ2 时拉低；BA 的低电平会提前覆盖最多三个 CPU 写周期。
    this.currentAecLow = badLineCycle.aecLow || result.spriteDataOffsets.phi2 !== undefined;
    const completedRasterLine =
      this.cyclePosition === this.timing.cyclesPerRasterLine ? this.rasterPosition : undefined;

    result.aecLow = this.currentAecLow;
    result.baLow = this.currentBaLow;
    result.badLine = this.currentBadLine;
    result.badLineCondition = badLineCycle.condition;
    result.busSchedule = busSchedule;
    result.completedRasterLine = completedRasterLine;
    result.cycle = this.cyclePosition;
    result.enterDisplayState = badLineCycle.enterDisplayState;
    result.frameStarted = frameStarted;
    result.lateVideoCounterReloadColumn = badLineCycle.lateVideoCounterReloadColumn;
    result.lineStarted = lineStarted;
    result.matrixAccess = badLineCycle.matrixAccess;
    result.rasterLine = this.rasterPosition;
    result.resetRowCounter = badLineCycle.resetRowCounter;
    result.spriteDisplayMask = this.currentSpriteDisplayMask;
    result.spriteDmaMask = this.currentSpriteDmaMask;
  }

  reset(): void {
    this.badLineController.reset();
    this.currentAecLow = false;
    this.currentBaLow = false;
    this.currentBadLine = false;
    this.currentSpriteDisplayMask = 0;
    this.currentSpriteDmaMask = 0;
    this.cyclePosition = 0;
    this.rasterPosition = 0;
    for (const sprite of this.spriteDma) sprite.reset();
  }

  private updateSpriteDma(signals: VicCycleSignals): void {
    let dmaMaskChanged = false;
    if (this.cyclePosition === this.timing.sprite.memoryCounterUpdateCycle) {
      for (const sprite of this.spriteDma) sprite.updateMemoryCounterBase();
      dmaMaskChanged = true;
    }

    if (
      this.cyclePosition === this.timing.sprite.dmaCheckCycles[0] ||
      this.cyclePosition === this.timing.sprite.dmaCheckCycles[1]
    ) {
      for (let index = 0; index < this.spriteDma.length; index += 1) {
        const bit = 1 << index;
        const sprite = this.spriteDma[index];
        if (
          sprite &&
          !sprite.active &&
          (signals.spriteEnableMask & bit) !== 0 &&
          signals.spriteY(index) === (this.rasterPosition & 0xff)
        ) {
          sprite.start();
        }
      }
      dmaMaskChanged = true;
    }

    if (this.cyclePosition === this.timing.sprite.expansionCheckCycle) {
      for (let index = 0; index < this.spriteDma.length; index += 1) {
        this.spriteDma[index]?.clockVerticalExpansion(
          (signals.spriteVerticalExpansionMask & (1 << index)) !== 0,
        );
      }
    }

    if (this.cyclePosition === this.timing.sprite.prepareDisplayCycle) {
      for (let index = 0; index < this.spriteDma.length; index += 1) {
        const bit = 1 << index;
        this.spriteDma[index]?.prepareDisplayRow(
          (signals.spriteEnableMask & bit) !== 0 &&
            signals.spriteY(index) === (this.rasterPosition & 0xff),
        );
      }
      this.currentSpriteDisplayMask = this.composeSpriteDisplayMask();
    }

    // active 只会在 MCBASE 更新或 DMA 启动检查时改变；displayActive 只会在
    // prepareDisplayRow 时改变。其余周期复用已组合的位掩码，避免每周期扫描全部精灵。
    if (dmaMaskChanged) this.currentSpriteDmaMask = this.composeSpriteDmaMask();
  }

  private consumeScheduledSpriteData(
    busSchedule: VicBusScheduleEntry,
    result: VicCycleResultBuffer['spriteDataOffsets'],
  ): void {
    // 先消耗 φ1、再消耗 φ2；返回值是数据真正上总线之前的 MC 偏移。
    const phi1 =
      busSchedule.phi1.kind === 'spriteData'
        ? this.spriteDma[busSchedule.phi1.spriteIndex]?.consumeDataByte()
        : undefined;
    const phi2 =
      busSchedule.phi2?.kind === 'spriteData'
        ? this.spriteDma[busSchedule.phi2.spriteIndex]?.consumeDataByte()
        : undefined;
    result.phi1 = phi1;
    result.phi2 = phi2;
  }

  private composeSpriteDmaMask(): number {
    let mask = 0;
    for (let index = 0; index < this.spriteDma.length; index += 1) {
      if (this.spriteDma[index]?.active) mask |= 1 << index;
    }
    return mask;
  }

  private composeSpriteDisplayMask(): number {
    let mask = 0;
    for (let index = 0; index < this.spriteDma.length; index += 1) {
      if (this.spriteDma[index]?.displayActive) mask |= 1 << index;
    }
    return mask;
  }

  private buildSpriteBaMaskTable(): Uint8Array {
    const masks = new Uint8Array(this.timing.cyclesPerRasterLine + 1);
    for (let index = 0; index < VIC_SPRITE_COUNT; index += 1) {
      const firstCycle = this.wrapCycle(
        this.timing.sprite.baFirstCycle + index * this.timing.sprite.startCycleSpacing,
      );
      for (let offset = 0; offset < this.timing.sprite.baCycleCount; offset += 1) {
        const cycle = this.wrapCycle(firstCycle + offset);
        masks[cycle] = (masks[cycle] ?? 0) | (1 << index);
      }
    }
    return masks;
  }

  private wrapCycle(cycle: number): number {
    return ((cycle - 1) % this.timing.cyclesPerRasterLine) + 1;
  }
}

export function createVicCycleResultBuffer(): VicCycleResultBuffer {
  return {
    aecLow: false,
    baLow: false,
    badLine: false,
    badLineCondition: false,
    busSchedule: vicBusScheduleForCycle(1),
    completedRasterLine: undefined,
    cycle: 0,
    enterDisplayState: false,
    frameStarted: false,
    lateVideoCounterReloadColumn: undefined,
    lineStarted: false,
    matrixAccess: undefined,
    rasterLine: 0,
    resetRowCounter: false,
    spriteDataOffsets: { phi1: undefined, phi2: undefined },
    spriteDisplayMask: 0,
    spriteDmaMask: 0,
  };
}
