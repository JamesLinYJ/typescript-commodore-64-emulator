// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Canvas 像素转换测试
//
//   文件:       CanvasSurface.test.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';
import { copyArgbPixelsToRgbaWords } from '../../src/video/CanvasSurface';

const PAL_OUTPUT_WIDTH = 403;
const PAL_OUTPUT_HEIGHT = 284;
const SENTINEL_BYTE = 0x5a;

describe('copyArgbPixelsToRgbaWords', () => {
  it('converts every PAL output pixel to exact RGBA bytes without touching adjacent pixels', () => {
    const pixelCount = PAL_OUTPUT_WIDTH * PAL_OUTPUT_HEIGHT;
    const source = new Uint32Array(pixelCount);

    for (let index = 0; index < source.length; index += 1) {
      const alpha = (index * 29 + 3) & 0xff;
      const red = (index * 31 + 5) & 0xff;
      const green = (index * 37 + 7) & 0xff;
      const blue = (index * 41 + 11) & 0xff;
      source[index] = (alpha << 24) | (red << 16) | (green << 8) | blue;
    }

    const destinationBytes = new Uint8ClampedArray((pixelCount + 2) * 4);
    destinationBytes.fill(SENTINEL_BYTE);
    const destinationWords = new Uint32Array(destinationBytes.buffer);
    const expectedBytes = destinationBytes.slice();

    for (let index = 0; index < source.length; index += 1) {
      const color = source[index];
      if (color === undefined) throw new Error(`Missing source pixel ${index}.`);
      const byteOffset = (index + 1) * 4;
      expectedBytes[byteOffset] = (color >>> 16) & 0xff;
      expectedBytes[byteOffset + 1] = (color >>> 8) & 0xff;
      expectedBytes[byteOffset + 2] = color & 0xff;
      expectedBytes[byteOffset + 3] = color >>> 24;
    }

    copyArgbPixelsToRgbaWords(source, destinationWords, 1);

    const firstDifferentByte = destinationBytes.findIndex(
      (value, index) => value !== expectedBytes[index],
    );
    expect(firstDifferentByte).toBe(-1);
  });

  it('rejects an offset that cannot hold the complete source', () => {
    expect(() => copyArgbPixelsToRgbaWords(new Uint32Array(2), new Uint32Array(2), 1)).toThrow(
      RangeError,
    );
  });
});
