// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 可写 TAP 磁带镜像测试
//
//   文件:       WritableTapImage.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  parseTapImage,
  TAP_IMAGE_LAYOUT,
  TAP_VERSION,
  TAP_VIDEO_STANDARD,
} from '../../src/media/TapImageParser';
import { WritableTapImage } from '../../src/media/WritableTapImage';

describe('WritableTapImage', () => {
  it('serializes quantized and precise pulses into a standard TAP v1 image', () => {
    const image = new WritableTapImage({ videoStandard: TAP_VIDEO_STANDARD.ntsc });
    image.appendPulse(384);
    image.appendPulse(529);
    image.appendPulse(0xff_ffff);

    const bytes = image.toBytes();
    expect(bytes.subarray(0, TAP_IMAGE_LAYOUT.magicLength)).toEqual(
      Uint8Array.from(TAP_IMAGE_LAYOUT.magic, (character) => character.charCodeAt(0)),
    );
    expect(bytes[TAP_IMAGE_LAYOUT.versionOffset]).toBe(TAP_VERSION.precise);
    expect(bytes[TAP_IMAGE_LAYOUT.videoStandardOffset]).toBe(TAP_VIDEO_STANDARD.ntsc);
    expect(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        TAP_IMAGE_LAYOUT.dataLengthOffset,
        true,
      ),
    ).toBe(9);
    expect([...bytes.subarray(TAP_IMAGE_LAYOUT.headerSize)]).toEqual([
      0x30, 0x00, 0x11, 0x02, 0x00, 0x00, 0xff, 0xff, 0xff,
    ]);

    const parsed = parseTapImage(bytes);
    expect(parsed.writable).toBe(false);
    expect(
      parsed.pulses.map(({ encodedLength, sourceCycles }) => ({ encodedLength, sourceCycles })),
    ).toEqual([
      { encodedLength: 1, sourceCycles: 384 },
      { encodedLength: 4, sourceCycles: 529 },
      { encodedLength: 4, sourceCycles: 0xff_ffff },
    ]);
    expect(parsed.totalSourceCycles).toBe(384 + 529 + 0xff_ffff);
  });

  it('rejects unrepresentable pulses without mutating the recorded image', () => {
    const image = new WritableTapImage();
    image.appendPulse(8);

    for (const invalidDuration of [0, -1, 1.5, Number.NaN, 0x01_00_00_00]) {
      expect(() => image.appendPulse(invalidDuration)).toThrow(RangeError);
    }
    expect(image.pulses).toHaveLength(1);
    expect(image.totalSourceCycles).toBe(8);
    expect([...image.toBytes().subarray(TAP_IMAGE_LAYOUT.headerSize)]).toEqual([1]);
  });

  it('truncates at a pulse boundary while preserving offsets and accumulated duration', () => {
    const image = new WritableTapImage();
    image.appendPulse(8);
    image.appendPulse(529);
    image.appendPulse(16);

    image.truncateAtPulse(2);
    image.appendPulse(24);
    expect(image.pulses).toEqual([
      { dataOffset: 0, encodedLength: 1, sourceCycles: 8 },
      { dataOffset: 1, encodedLength: 4, sourceCycles: 529 },
      { dataOffset: 5, encodedLength: 1, sourceCycles: 24 },
    ]);
    expect(image.totalSourceCycles).toBe(561);
    expect(() => image.truncateAtPulse(4)).toThrow(RangeError);
  });
});
