// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II PAL 时序参数
//
//   文件:       VicTiming.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export interface VicTiming {
  readonly badLine: {
    readonly baFirstCycle: number;
    readonly baLastCycle: number;
    readonly firstRasterLine: number;
    readonly lastRasterLine: number;
  };
  readonly border: {
    readonly reducedColumnLeftCycle: number;
    readonly reducedColumnRightCycle: number;
    readonly reducedRowStartLine: number;
    readonly reducedRowStopLine: number;
    readonly standardColumnLeftCycle: number;
    readonly standardColumnRightCycle: number;
    readonly standardRowStartLine: number;
    readonly standardRowStopLine: number;
  };
  readonly cyclesPerRasterLine: number;
  readonly fetch: {
    readonly graphicsFirstCycle: number;
    readonly graphicsLastCycle: number;
    readonly idleFirstCycle: number;
    readonly idleLastCycle: number;
    readonly matrixFirstCycle: number;
    readonly matrixLastCycle: number;
    readonly rowCounterUpdateCycle: number;
    readonly refreshFirstCycle: number;
    readonly refreshLastCycle: number;
    readonly videoCounterReloadCycle: number;
  };
  readonly lightPen: {
    readonly horizontalOriginPixels: number;
    readonly horizontalPositionModuloPixels: number;
    readonly mos6569R3RegisterOffset: number;
    readonly triggerDelayCycles: number;
  };
  readonly rasterLineCount: number;
  readonly sprite: {
    readonly baCycleCount: number;
    readonly baFirstCycle: number;
    readonly bytesPerRow: number;
    readonly dataFirstCycle: number;
    readonly dmaCheckCycles: readonly [number, number];
    readonly expansionCheckCycle: number;
    readonly lineDataReadyCycle: number;
    readonly memoryCounterCrunchCycle: number;
    readonly memoryCounterUpdateCycle: number;
    readonly prepareDisplayCycle: number;
    readonly startCycleSpacing: number;
  };
}

// 这些常量描述 PAL 6569 每条 63 周期光栅线上的总线窗口。集中配置可让时序器只表达
// 状态转换，也为后续增加 NTSC 芯片型号保留明确边界。
export const PAL_VIC_TIMING: VicTiming = {
  badLine: {
    baFirstCycle: 12,
    baLastCycle: 54,
    firstRasterLine: 0x30,
    lastRasterLine: 0xf7,
  },
  border: {
    reducedColumnLeftCycle: 18,
    reducedColumnRightCycle: 56,
    reducedRowStartLine: 0x37,
    reducedRowStopLine: 0xf7,
    standardColumnLeftCycle: 17,
    standardColumnRightCycle: 57,
    standardRowStartLine: 0x33,
    standardRowStopLine: 0xfb,
  },
  cyclesPerRasterLine: 63,
  fetch: {
    graphicsFirstCycle: 16,
    graphicsLastCycle: 55,
    idleFirstCycle: 56,
    idleLastCycle: 57,
    matrixFirstCycle: 15,
    matrixLastCycle: 54,
    rowCounterUpdateCycle: 58,
    refreshFirstCycle: 11,
    refreshLastCycle: 15,
    videoCounterReloadCycle: 14,
  },
  lightPen: {
    // PAL 6569R3 的第一个 φ1 周期从光栅横坐标 $194 开始，计数在 504 像素处回卷。
    horizontalOriginPixels: 0x194,
    horizontalPositionModuloPixels: 504,
    mos6569R3RegisterOffset: 2,
    triggerDelayCycles: 1,
  },
  rasterLineCount: 312,
  sprite: {
    baCycleCount: 5,
    baFirstCycle: 55,
    bytesPerRow: 3,
    dataFirstCycle: 58,
    dmaCheckCycles: [55, 56],
    expansionCheckCycle: 56,
    lineDataReadyCycle: 10,
    memoryCounterCrunchCycle: 15,
    memoryCounterUpdateCycle: 16,
    prepareDisplayCycle: 58,
    startCycleSpacing: 2,
  },
};
