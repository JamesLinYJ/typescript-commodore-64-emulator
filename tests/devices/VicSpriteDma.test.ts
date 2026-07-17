// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 精灵 DMA 状态测试
//
//   文件:       VicSpriteDma.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { VicSpriteDma } from '../../src/devices/VicSpriteDma';

describe('VicSpriteDma', () => {
  it('restores MCBASE progression when vertical expansion is cleared', () => {
    const dma = new VicSpriteDma();
    dma.start();
    dma.clockVerticalExpansion(true);
    expect(dma.consumeDataByte()).toBe(0);
    expect(dma.consumeDataByte()).toBe(1);
    expect(dma.consumeDataByte()).toBe(2);

    dma.clearVerticalExpansion(false);
    dma.updateMemoryCounterBase();

    expect(dma.expansionFlipFlop).toBe(true);
    expect(dma.memoryCounterBase).toBe(3);
  });

  it('interleaves MC and MCBASE bits when D017 is cleared on the crunch cycle', () => {
    const dma = new VicSpriteDma();
    dma.start();
    for (let byte = 0; byte < 6; byte += 1) dma.consumeDataByte();
    dma.updateMemoryCounterBase();
    for (let byte = 0; byte < 3; byte += 1) dma.consumeDataByte();
    dma.clockVerticalExpansion(true);

    dma.clearVerticalExpansion(true);
    dma.updateMemoryCounterBase();

    expect(dma.memoryCounterBase).toBe(0x05);
  });
});
