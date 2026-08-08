// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 边框触发器
//
//   文件:       VicBorderController.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { PAL_VIC_TIMING, type VicTiming } from './VicTiming';

const VIC_BORDER_PIXEL_MASK = {
  all: 0xff,
  firstSeven: 0xfe,
  last: 0x01,
  none: 0x00,
} as const;

export interface VicBorderSignals {
  readonly columnSelect: boolean;
  readonly displayEnabled: boolean;
  readonly rasterCycle: number;
  readonly rasterLine: number;
  readonly rowSelect: boolean;
}

// verticalBorder 对应垂直边框触发器，pendingVerticalBorder 对应延迟生效的 set_vborder。
// renderedBorder 保留上一个 8 像素组的输出状态，用来表达 38 列模式边界处的 7+1 像素转换。
export class VicBorderController {
  private verticalBorder = true;
  private pendingVerticalBorder = true;
  private mainBorder = true;
  private renderedBorder = true;

  constructor(private readonly timing: VicTiming = PAL_VIC_TIMING) {}

  tick(signals: VicBorderSignals): number {
    return this.tickCycle(
      signals.columnSelect,
      signals.displayEnabled,
      signals.rasterCycle,
      signals.rasterLine,
      signals.rowSelect,
    );
  }

  tickCycle(
    columnSelect: boolean,
    displayEnabled: boolean,
    rasterCycle: number,
    rasterLine: number,
    rowSelect: boolean,
  ): number {
    this.checkHorizontalBorder(columnSelect, rasterCycle, rasterLine, rowSelect);
    const pixelMask = this.drawPixelMask(columnSelect);

    // 精确模型在当前周期的像素生成后更新垂直触发器，因此顶边界不会提前影响同周期像素。
    this.checkVerticalBorderTop(displayEnabled, rasterLine, rowSelect);
    this.checkVerticalBorderBottom(rasterLine, rowSelect);
    if (rasterCycle === 1) this.verticalBorder = this.pendingVerticalBorder;

    return pixelMask;
  }

  reset(): void {
    this.verticalBorder = true;
    this.pendingVerticalBorder = true;
    this.mainBorder = true;
    this.renderedBorder = true;
  }

  private checkHorizontalBorder(
    columnSelect: boolean,
    rasterCycle: number,
    rasterLine: number,
    rowSelect: boolean,
  ): void {
    const leftCycle = columnSelect
      ? this.timing.border.standardColumnLeftCycle
      : this.timing.border.reducedColumnLeftCycle;
    if (rasterCycle === leftCycle) {
      this.checkVerticalBorderBottom(rasterLine, rowSelect);
      this.verticalBorder = this.pendingVerticalBorder;
      if (!this.verticalBorder) this.mainBorder = false;
    }

    const rightCycle = columnSelect
      ? this.timing.border.standardColumnRightCycle
      : this.timing.border.reducedColumnRightCycle;
    if (rasterCycle === rightCycle) this.mainBorder = true;
  }

  private checkVerticalBorderTop(
    displayEnabled: boolean,
    rasterLine: number,
    rowSelect: boolean,
  ): void {
    const startLine = rowSelect
      ? this.timing.border.standardRowStartLine
      : this.timing.border.reducedRowStartLine;
    if (rasterLine === startLine && displayEnabled) {
      this.verticalBorder = false;
      this.pendingVerticalBorder = false;
    }
  }

  private checkVerticalBorderBottom(rasterLine: number, rowSelect: boolean): void {
    const stopLine = rowSelect
      ? this.timing.border.standardRowStopLine
      : this.timing.border.reducedRowStopLine;
    if (rasterLine === stopLine) this.pendingVerticalBorder = true;
  }

  private drawPixelMask(columnSelect: boolean): number {
    if (!this.renderedBorder && !this.mainBorder) return VIC_BORDER_PIXEL_MASK.none;
    if (this.renderedBorder && this.mainBorder) return VIC_BORDER_PIXEL_MASK.all;

    if (columnSelect) {
      const mask = this.renderedBorder ? VIC_BORDER_PIXEL_MASK.all : VIC_BORDER_PIXEL_MASK.none;
      this.renderedBorder = this.mainBorder;
      return mask;
    }

    const mask =
      (this.renderedBorder ? VIC_BORDER_PIXEL_MASK.firstSeven : VIC_BORDER_PIXEL_MASK.none) |
      (this.mainBorder ? VIC_BORDER_PIXEL_MASK.last : VIC_BORDER_PIXEL_MASK.none);
    this.renderedBorder = this.mainBorder;
    return mask;
  }
}
