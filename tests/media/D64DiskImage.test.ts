// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - D64 磁盘镜像测试
//
//   文件:       D64DiskImage.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  D64DiskImage,
  D64_ERROR_CODE,
  D64_LAYOUT,
  d64SectorCountThroughTrack,
  d64SectorsOnTrack,
} from '../../src/media/D64DiskImage';

function createD64Bytes(trackCount = 35, includeErrors = false): Uint8Array {
  const sectorCount = d64SectorCountThroughTrack(trackCount);
  const dataLength = sectorCount * D64_LAYOUT.sectorSize;
  const bytes = new Uint8Array(dataLength + (includeErrors ? sectorCount : 0));
  if (includeErrors) bytes.fill(D64_ERROR_CODE.ok, dataLength);
  return bytes;
}

describe('D64DiskImage', () => {
  it('recognizes every supported 35 through 42 track geometry with optional error info', () => {
    for (let trackCount = 35; trackCount <= 42; trackCount += 1) {
      for (const includeErrors of [false, true]) {
        const image = new D64DiskImage(createD64Bytes(trackCount, includeErrors));
        expect(image.trackCount).toBe(trackCount);
        expect(image.sectorCount).toBe(d64SectorCountThroughTrack(trackCount));
        expect(image.hasErrorInfo).toBe(includeErrors);
      }
    }
  });

  it('uses the physical 21/19/18/17-sector zoning table', () => {
    expect(d64SectorsOnTrack(1)).toBe(21);
    expect(d64SectorsOnTrack(17)).toBe(21);
    expect(d64SectorsOnTrack(18)).toBe(19);
    expect(d64SectorsOnTrack(24)).toBe(19);
    expect(d64SectorsOnTrack(25)).toBe(18);
    expect(d64SectorsOnTrack(30)).toBe(18);
    expect(d64SectorsOnTrack(31)).toBe(17);
    expect(d64SectorsOnTrack(42)).toBe(17);
  });

  it('maps track and sector coordinates to exact linear image offsets', () => {
    const bytes = createD64Bytes();
    const track18Sector0Index = d64SectorCountThroughTrack(17);
    bytes[track18Sector0Index * D64_LAYOUT.sectorSize] = 0x18;
    bytes[(track18Sector0Index + 18) * D64_LAYOUT.sectorSize + 0xff] = 0xee;
    const image = new D64DiskImage(bytes);

    expect(image.readSector(18, 0)[0]).toBe(0x18);
    expect(image.readSector(18, 18)[0xff]).toBe(0xee);
    expect(() => image.readSector(18, 19)).toThrow(/contains sectors 0..18/);
  });

  it('reads the disk ID from the track 18 directory header sector', () => {
    const bytes = createD64Bytes();
    const directoryOffset = d64SectorCountThroughTrack(17) * D64_LAYOUT.sectorSize;
    bytes[directoryOffset + D64_LAYOUT.directoryHeader.diskId1Offset] = 0x4a;
    bytes[directoryOffset + D64_LAYOUT.directoryHeader.diskId2Offset] = 0x53;

    expect(new D64DiskImage(bytes).diskId).toEqual({ id1: 0x4a, id2: 0x53 });
  });

  it('preserves error-info bytes and resets a successfully rewritten sector to OK', () => {
    const bytes = createD64Bytes(35, true);
    const dataLength = d64SectorCountThroughTrack(35) * D64_LAYOUT.sectorSize;
    bytes[dataLength] = D64_ERROR_CODE.dataChecksum;
    const image = new D64DiskImage(bytes);

    expect(image.errorCode(1, 0)).toBe(D64_ERROR_CODE.dataChecksum);
    image.writeSector(1, 0, new Uint8Array(D64_LAYOUT.sectorSize));
    expect(image.errorCode(1, 0)).toBe(D64_ERROR_CODE.ok);
    expect(image.toBytes()).toHaveLength(bytes.length);
  });

  it('enforces write protection, sector size, valid errors, and exact file geometry', () => {
    const protectedImage = new D64DiskImage(createD64Bytes(), { writeProtected: true });
    expect(() => protectedImage.writeSector(1, 0, new Uint8Array(D64_LAYOUT.sectorSize))).toThrow(
      /write-protected/,
    );

    const image = new D64DiskImage(createD64Bytes());
    expect(() => image.writeSector(1, 0, new Uint8Array(1))).toThrow(/require 256 bytes/);
    expect(() => image.setErrorCode(1, 0, 6 as never)).toThrow(/not defined by CBM DOS/);
    expect(() => new D64DiskImage(new Uint8Array(100))).toThrow(/Unsupported D64 size/);
  });
});
