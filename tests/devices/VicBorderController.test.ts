// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 边框触发器测试
//
//   文件:       VicBorderController.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { VicBorderController } from '../../src/devices/VicBorderController';
import { PAL_VIC_TIMING } from '../../src/devices/VicTiming';

interface LineOptions {
  readonly columnSelect: boolean;
  readonly displayEnabled: boolean;
  readonly rowSelect: boolean;
}

function runLine(
  controller: VicBorderController,
  rasterLine: number,
  options: LineOptions,
): Uint8Array {
  const masks = new Uint8Array(PAL_VIC_TIMING.cyclesPerRasterLine);
  for (let cycle = 1; cycle <= PAL_VIC_TIMING.cyclesPerRasterLine; cycle += 1) {
    masks[cycle - 1] = controller.tick({
      ...options,
      rasterCycle: cycle,
      rasterLine,
    });
  }
  return masks;
}

function advanceToLine(
  controller: VicBorderController,
  targetLine: number,
  options: LineOptions,
): Uint8Array {
  for (let rasterLine = 0; rasterLine < targetLine; rasterLine += 1) {
    runLine(controller, rasterLine, options);
  }
  return runLine(controller, targetLine, options);
}

describe('VicBorderController', () => {
  it('opens and closes the standard 40-column display on PAL border cycles', () => {
    const controller = new VicBorderController();
    const masks = advanceToLine(controller, PAL_VIC_TIMING.border.standardRowStartLine, {
      columnSelect: true,
      displayEnabled: true,
      rowSelect: true,
    });

    expect(masks[PAL_VIC_TIMING.border.standardColumnLeftCycle - 1]).toBe(0xff);
    expect(masks[PAL_VIC_TIMING.border.standardColumnLeftCycle]).toBe(0x00);
    expect(masks[PAL_VIC_TIMING.border.standardColumnRightCycle - 1]).toBe(0x00);
    expect(masks[PAL_VIC_TIMING.border.standardColumnRightCycle]).toBe(0xff);
  });

  it('preserves the seven-plus-one pixel transition in 38-column mode', () => {
    const controller = new VicBorderController();
    const masks = advanceToLine(controller, PAL_VIC_TIMING.border.reducedRowStartLine, {
      columnSelect: false,
      displayEnabled: true,
      rowSelect: false,
    });

    expect(masks[PAL_VIC_TIMING.border.reducedColumnLeftCycle - 1]).toBe(0xfe);
    expect(masks[PAL_VIC_TIMING.border.reducedColumnRightCycle - 1]).toBe(0x01);
  });

  it('keeps the right and following left border open when both CSEL checks are missed', () => {
    const controller = new VicBorderController();
    const activeLine = PAL_VIC_TIMING.border.standardRowStartLine + 8;
    const options = { columnSelect: true, displayEnabled: true, rowSelect: true } as const;
    for (let rasterLine = 0; rasterLine < activeLine; rasterLine += 1) {
      runLine(controller, rasterLine, options);
    }

    const masks = new Uint8Array(PAL_VIC_TIMING.cyclesPerRasterLine);
    for (let cycle = 1; cycle <= PAL_VIC_TIMING.cyclesPerRasterLine; cycle += 1) {
      const columnSelect = cycle !== PAL_VIC_TIMING.border.standardColumnRightCycle;
      masks[cycle - 1] = controller.tick({
        columnSelect,
        displayEnabled: true,
        rasterCycle: cycle,
        rasterLine: activeLine,
        rowSelect: true,
      });
    }
    const followingLine = runLine(controller, activeLine + 1, options);

    expect(masks[PAL_VIC_TIMING.border.standardColumnRightCycle]).toBe(0x00);
    expect(followingLine[0]).toBe(0x00);
  });
});
