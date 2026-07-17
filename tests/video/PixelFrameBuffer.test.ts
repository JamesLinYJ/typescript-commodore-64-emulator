// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 像素帧缓冲区测试
//
//   文件:       PixelFrameBuffer.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { PixelFrameBuffer } from '../../src/video/PixelFrameBuffer';

describe('PixelFrameBuffer', () => {
  it('writes complete scanlines without applying presentation-layer composition', () => {
    const frame = new PixelFrameBuffer(3, 2);
    frame.clear(0xff000001);
    frame.writeRow(1, Uint32Array.of(0xff102030, 0xff405060, 0xff708090));

    expect(frame.pixels).toEqual(
      Uint32Array.of(0xff000001, 0xff000001, 0xff000001, 0xff102030, 0xff405060, 0xff708090),
    );
  });

  it('rejects invalid geometry, rows, and widths instead of clipping hardware output', () => {
    expect(() => new PixelFrameBuffer(0, 1)).toThrow(/positive integers/);
    const frame = new PixelFrameBuffer(2, 1);
    expect(() => frame.writeRow(-1, Uint32Array.of(1, 2))).toThrow(/outside/);
    expect(() => frame.writeRow(0, Uint32Array.of(1))).toThrow(/does not match/);
  });
});
