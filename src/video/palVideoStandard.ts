export const PAL_VIDEO_STANDARD = {
  timing: {
    refreshRateHz: 50.124_542,
    rasterLineCount: 312,
    cpuCyclesPerRasterLine: 63,
    processorClockHz: 985_248,
    maximumFrameDeltaMs: 100,
  },
  output: {
    width: 403,
    height: 284,
    firstVisibleCycle: 12,
    firstVisibleRaster: 16,
    lastVisibleRasterExclusive: 300,
    pixelsPerCycle: 8,
  },
  textDisplay: {
    x: 48,
    y: 32,
    width: 320,
    columnCount: 40,
    characterWidth: 8,
    characterHeight: 8,
    firstRaster: 50,
    lastRaster: 250,
    verticalScrollBaseline: 3,
  },
  sprite: {
    width: 24,
    canvasXOffset: 24,
  },
} as const;
