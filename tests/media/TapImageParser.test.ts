// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - TAP 磁带镜像解析测试
//
//   文件:       TapImageParser.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  parseTapImage,
  TAP_IMAGE_LAYOUT,
  TAP_VERSION,
  TAP_VIDEO_STANDARD,
} from '../../src/media/TapImageParser';

function createTap(
  data: readonly number[],
  options: { readonly system?: number; readonly version?: number; readonly video?: number } = {},
): Uint8Array {
  const bytes = new Uint8Array(TAP_IMAGE_LAYOUT.headerSize + data.length);
  bytes.set(Uint8Array.from(TAP_IMAGE_LAYOUT.magic, (character) => character.charCodeAt(0)));
  bytes[TAP_IMAGE_LAYOUT.versionOffset] = options.version ?? TAP_VERSION.precise;
  bytes[TAP_IMAGE_LAYOUT.systemOffset] = options.system ?? 0;
  bytes[TAP_IMAGE_LAYOUT.videoStandardOffset] = options.video ?? TAP_VIDEO_STANDARD.pal;
  const view = new DataView(bytes.buffer);
  view.setUint32(TAP_IMAGE_LAYOUT.dataLengthOffset, data.length, true);
  bytes.set(data, TAP_IMAGE_LAYOUT.headerSize);
  return bytes;
}

describe('parseTapImage', () => {
  it('decodes TAP v0 one-byte pulse units as eight source CPU cycles', () => {
    const image = parseTapImage(createTap([1, 0xff], { version: TAP_VERSION.legacy }));
    expect(image.pulses).toEqual([
      { dataOffset: 0, encodedLength: 1, sourceCycles: 8 },
      { dataOffset: 1, encodedLength: 1, sourceCycles: 2040 },
    ]);
    expect(image.totalSourceCycles).toBe(2048);
    expect(image.sourceClockHz).toBe(985_248);
  });

  it('requires an explicit duration for the information-losing TAP v0 zero marker', () => {
    const bytes = createTap([0], { version: TAP_VERSION.legacy });
    expect(() => parseTapImage(bytes)).toThrow(/provide legacyV0OverflowPulseCycles/);
    expect(parseTapImage(bytes, { legacyV0OverflowPulseCycles: 2500 }).pulses[0]).toEqual({
      dataOffset: 0,
      encodedLength: 1,
      sourceCycles: 2500,
    });
  });

  it('decodes TAP v1 24-bit extended pulse lengths without dividing them by eight', () => {
    const image = parseTapImage(
      createTap([2, 0, 0x34, 0x12, 0x00], {
        version: TAP_VERSION.precise,
        video: TAP_VIDEO_STANDARD.ntsc,
      }),
    );
    expect(image.pulses).toEqual([
      { dataOffset: 0, encodedLength: 1, sourceCycles: 16 },
      { dataOffset: 1, encodedLength: 4, sourceCycles: 0x1234 },
    ]);
    expect(image.sourceClockHz).toBe(1_022_730);
  });

  it('validates signature, C64 system, version, declared length, and extended records', () => {
    const badMagic = createTap([1]);
    badMagic[0] = 0;
    expect(() => parseTapImage(badMagic)).toThrow(/does not begin/);
    expect(() => parseTapImage(createTap([1], { system: 2 }))).toThrow(/not a Commodore 64/);
    expect(() => parseTapImage(createTap([1], { version: 2 }))).toThrow(/expected version 0 or 1/);

    const badLength = createTap([1]);
    new DataView(badLength.buffer).setUint32(TAP_IMAGE_LAYOUT.dataLengthOffset, 2, true);
    expect(() => parseTapImage(badLength)).toThrow(/declares 2 data bytes/);
    expect(() => parseTapImage(createTap([0, 1, 2]))).toThrow(/truncated/);
    expect(() => parseTapImage(createTap([0, 0, 0, 0]))).toThrow(/zero length/);
  });
});
