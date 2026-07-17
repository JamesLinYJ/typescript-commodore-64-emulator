// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - G64 原始磁道镜像测试
//
//   文件:       G64DiskImage.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { G64DiskImage, G64_LAYOUT } from '../../src/media/G64DiskImage';

const TEST_HALF_TRACK_COUNT = 4;
const TEST_MAXIMUM_TRACK_LENGTH = 8;
const TEST_TABLE_END = G64_LAYOUT.headerSize + TEST_HALF_TRACK_COUNT * 8;
const TEST_TRACK_BLOCK_LENGTH = 2 + TEST_MAXIMUM_TRACK_LENGTH;
const TEST_SPEED_MAP_LENGTH = TEST_MAXIMUM_TRACK_LENGTH / 4;

function createG64Fixture(): Uint8Array {
  const trackOffset = TEST_TABLE_END;
  const speedMapOffset = trackOffset + TEST_TRACK_BLOCK_LENGTH;
  const bytes = new Uint8Array(speedMapOffset + TEST_SPEED_MAP_LENGTH);
  bytes.set(Uint8Array.from(G64_LAYOUT.signature, (character) => character.charCodeAt(0)));
  bytes[G64_LAYOUT.versionOffset] = G64_LAYOUT.supportedVersion;
  bytes[G64_LAYOUT.trackCountOffset] = TEST_HALF_TRACK_COUNT;
  writeUint16(bytes, G64_LAYOUT.maximumTrackLengthOffset, TEST_MAXIMUM_TRACK_LENGTH);
  writeUint32(bytes, G64_LAYOUT.trackOffsetTableOffset, trackOffset);

  const speedTableOffset = G64_LAYOUT.trackOffsetTableOffset + TEST_HALF_TRACK_COUNT * 4;
  writeUint32(bytes, speedTableOffset, speedMapOffset);
  writeUint32(bytes, speedTableOffset + 4, 3);
  writeUint32(bytes, speedTableOffset + 8, 2);
  writeUint32(bytes, speedTableOffset + 12, 1);

  const trackData = Uint8Array.of(0xff, 0x55, 0xa5, 0x00, 0x81);
  writeUint16(bytes, trackOffset, trackData.length);
  bytes.set(trackData, trackOffset + 2);
  // 四个两位字段从高到低分别描述同组的第 1..4 个磁道字节。
  bytes.set(Uint8Array.of(0b11_10_01_00, 0b01_01_01_01), speedMapOffset);
  return bytes;
}

describe('G64DiskImage', () => {
  it('parses raw half-tracks, absent entries, and per-byte speed zones', () => {
    const image = new G64DiskImage(createG64Fixture());

    expect(image.firstHalfTrack).toBe(2);
    expect(image.lastHalfTrack).toBe(5);
    expect(image.maximumTrackLength).toBe(TEST_MAXIMUM_TRACK_LENGTH);
    expect(image.readHalfTrack(2)?.bytes).toEqual(Uint8Array.of(0xff, 0x55, 0xa5, 0x00, 0x81));
    expect(image.readHalfTrack(3)).toBeUndefined();
    expect([0, 1, 2, 3, 4].map((index) => image.speedZoneAtByte(2, index))).toEqual([
      3, 2, 1, 0, 1,
    ]);
    expect(image.speedZoneAtByte(3, 0)).toBe(3);
  });

  it('serializes a canonical image without losing raw data or speed maps', () => {
    const original = new G64DiskImage(createG64Fixture());
    const reparsed = new G64DiskImage(original.toBytes());

    expect(reparsed.readHalfTrack(2)).toEqual(original.readHalfTrack(2));
    expect(reparsed.readHalfTrack(3)).toBeUndefined();
    expect(
      Array.from({ length: TEST_MAXIMUM_TRACK_LENGTH }, (_, index) =>
        reparsed.speedZoneAtByte(2, index),
      ),
    ).toEqual(
      Array.from({ length: TEST_MAXIMUM_TRACK_LENGTH }, (_, index) =>
        original.speedZoneAtByte(2, index),
      ),
    );
  });

  it('preserves a variable speed map even when its half-track is absent', () => {
    const bytes = createG64Fixture();
    const speedTableOffset = G64_LAYOUT.trackOffsetTableOffset + TEST_HALF_TRACK_COUNT * 4;
    const extraSpeedMapOffset = bytes.length;
    const extended = new Uint8Array(bytes.length + TEST_SPEED_MAP_LENGTH);
    extended.set(bytes);
    extended.set(Uint8Array.of(0b00_01_10_11, 0), extraSpeedMapOffset);
    writeUint32(extended, speedTableOffset + 4, extraSpeedMapOffset);

    const reparsed = new G64DiskImage(new G64DiskImage(extended).toBytes());

    expect(reparsed.readHalfTrack(3)).toBeUndefined();
    expect([0, 1, 2, 3].map((index) => reparsed.speedZoneAtByte(3, index))).toEqual([0, 1, 2, 3]);
  });

  it('supports explicit writable track replacement and byte writes', () => {
    const image = new G64DiskImage(createG64Fixture());
    image.setHalfTrack(3, Uint8Array.of(0x55, 0xaa), { kind: 'constant', zone: 2 });
    image.writeHalfTrackByte(3, 1, 0x7e, 3);

    expect(image.readHalfTrack(3)?.bytes).toEqual(Uint8Array.of(0x55, 0x7e));
    expect(image.speedZoneAtByte(3, 0)).toBe(2);
    expect(image.speedZoneAtByte(3, 1)).toBe(3);

    const protectedImage = new G64DiskImage(createG64Fixture(), { writeProtected: true });
    expect(() => protectedImage.writeHalfTrackByte(2, 0, 0)).toThrow(/write-protected/);
    expect(() => protectedImage.setHalfTrack(3, Uint8Array.of(0x55))).toThrow(/write-protected/);
  });

  it('extends a short offset table when the physical head records a later half-track', () => {
    const image = new G64DiskImage(createG64Fixture());
    expect(image.readHalfTrack(36)).toBeUndefined();
    expect(image.speedZoneAtByte(36, 0)).toBe(2);

    image.setHalfTrack(36, Uint8Array.of(0xa5), { kind: 'constant', zone: 2 });
    const reparsed = new G64DiskImage(image.toBytes());

    expect(reparsed.lastHalfTrack).toBe(36);
    expect(reparsed.readHalfTrack(36)?.bytes).toEqual(Uint8Array.of(0xa5));
  });

  it('rejects malformed headers, tables, offsets, and track lengths', () => {
    const badSignature = createG64Fixture();
    badSignature[0] = 0;
    expect(() => new G64DiskImage(badSignature)).toThrow(/does not begin/);

    const badVersion = createG64Fixture();
    badVersion[G64_LAYOUT.versionOffset] = 1;
    expect(() => new G64DiskImage(badVersion)).toThrow(/Unsupported G64 version/);

    const truncatedTables = createG64Fixture().slice(0, TEST_TABLE_END - 1);
    expect(() => new G64DiskImage(truncatedTables)).toThrow(/header tables/);

    const badTrackOffset = createG64Fixture();
    writeUint32(badTrackOffset, G64_LAYOUT.trackOffsetTableOffset, badTrackOffset.length - 1);
    expect(() => new G64DiskImage(badTrackOffset)).toThrow(/uint16/);

    const headerTrackOffset = createG64Fixture();
    writeUint32(headerTrackOffset, G64_LAYOUT.trackOffsetTableOffset, G64_LAYOUT.headerSize);
    expect(() => new G64DiskImage(headerTrackOffset)).toThrow(/inside the header tables/);

    const oversizedTrack = createG64Fixture();
    writeUint16(oversizedTrack, TEST_TABLE_END, TEST_MAXIMUM_TRACK_LENGTH + 1);
    expect(() => new G64DiskImage(oversizedTrack)).toThrow(/invalid length/);

    const badSpeedOffset = createG64Fixture();
    const speedTableOffset = G64_LAYOUT.trackOffsetTableOffset + TEST_HALF_TRACK_COUNT * 4;
    writeUint32(badSpeedOffset, speedTableOffset, badSpeedOffset.length);
    expect(() => new G64DiskImage(badSpeedOffset)).toThrow(/speed map/);
  });
});

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
