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
import { VicBadLineController, type VicMatrixAccess } from './VicBadLineController';
import { vicBusScheduleForCycle, type VicBusScheduleEntry } from './VicBusSchedule';
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

// 此状态机只负责光栅位置、坏线、BA 和精灵 DMA 计数，不访问 C64 内存。
// 实际地址形成与数据锁存由 VicFetchPipeline 通过窄总线接口完成。
export class VicCycleSequencer {
  private readonly badLineController: VicBadLineController;
  private readonly spriteDma = Array.from({ length: VIC_SPRITE_COUNT }, () => new VicSpriteDma());
  private currentAecLow = false;
  private currentBaLow = false;
  private currentBadLine = false;
  private currentSpriteDisplayMask = 0;
  private currentSpriteDmaMask = 0;
  private cyclePosition = 0;
  private rasterPosition = 0;

  constructor(private readonly timing: VicTiming = PAL_VIC_TIMING) {
    this.badLineController = new VicBadLineController(timing);
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

    const busSchedule = vicBusScheduleForCycle(this.cyclePosition);
    const badLineCycle = this.badLineController.tick({
      cycle: this.cyclePosition,
      displayEnabled: signals.displayEnabled,
      frameStarted,
      lineStarted,
      rasterLine: this.rasterPosition,
      verticalScroll: signals.verticalScroll,
    });
    this.currentBadLine = badLineCycle.active;
    this.updateSpriteDma(signals);
    this.currentSpriteDmaMask = this.composeSpriteDmaMask();
    this.currentSpriteDisplayMask = this.composeSpriteDisplayMask();
    const spriteDataOffsets = this.consumeScheduledSpriteData(busSchedule);
    this.currentBaLow =
      badLineCycle.baLow || (this.currentSpriteDmaMask & this.spriteBaMaskForCurrentCycle()) !== 0;
    // AEC 只在 VIC-II 真正占用 φ2 时拉低；BA 的低电平会提前覆盖最多三个 CPU 写周期。
    this.currentAecLow = badLineCycle.aecLow || spriteDataOffsets.phi2 !== undefined;
    const completedRasterLine =
      this.cyclePosition === this.timing.cyclesPerRasterLine ? this.rasterPosition : undefined;

    return {
      aecLow: this.currentAecLow,
      baLow: this.currentBaLow,
      badLine: this.currentBadLine,
      badLineCondition: badLineCycle.condition,
      busSchedule,
      completedRasterLine,
      cycle: this.cyclePosition,
      enterDisplayState: badLineCycle.enterDisplayState,
      frameStarted,
      lateVideoCounterReloadColumn: badLineCycle.lateVideoCounterReloadColumn,
      lineStarted,
      matrixAccess: badLineCycle.matrixAccess,
      rasterLine: this.rasterPosition,
      resetRowCounter: badLineCycle.resetRowCounter,
      spriteDataOffsets,
      spriteDisplayMask: this.currentSpriteDisplayMask,
      spriteDmaMask: this.currentSpriteDmaMask,
    };
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
    if (this.cyclePosition === this.timing.sprite.memoryCounterUpdateCycle) {
      for (const sprite of this.spriteDma) sprite.updateMemoryCounterBase();
    }

    if (this.timing.sprite.dmaCheckCycles.includes(this.cyclePosition)) {
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
    }
  }

  private consumeScheduledSpriteData(busSchedule: VicBusScheduleEntry): {
    readonly phi1: number | undefined;
    readonly phi2: number | undefined;
  } {
    // 先消耗 φ1、再消耗 φ2；返回值是数据真正上总线之前的 MC 偏移。
    const phi1 =
      busSchedule.phi1.kind === 'spriteData'
        ? this.spriteDma[busSchedule.phi1.spriteIndex]?.consumeDataByte()
        : undefined;
    const phi2 =
      busSchedule.phi2?.kind === 'spriteData'
        ? this.spriteDma[busSchedule.phi2.spriteIndex]?.consumeDataByte()
        : undefined;
    return { phi1, phi2 };
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

  private spriteBaMaskForCurrentCycle(): number {
    let mask = 0;
    for (let index = 0; index < VIC_SPRITE_COUNT; index += 1) {
      const firstCycle = this.wrapCycle(
        this.timing.sprite.baFirstCycle + index * this.timing.sprite.startCycleSpacing,
      );
      if (
        this.wrappedCycleDistance(firstCycle, this.cyclePosition) < this.timing.sprite.baCycleCount
      ) {
        mask |= 1 << index;
      }
    }
    return mask;
  }

  private wrapCycle(cycle: number): number {
    return ((cycle - 1) % this.timing.cyclesPerRasterLine) + 1;
  }

  private wrappedCycleDistance(firstCycle: number, cycle: number): number {
    return (cycle - firstCycle + this.timing.cyclesPerRasterLine) % this.timing.cyclesPerRasterLine;
  }
}
