// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Commodore GCR 编解码测试
//
//   文件:       CommodoreGcr.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  D64DiskImage,
  D64_ERROR_CODE,
  D64_LAYOUT,
  d64SectorCountThroughTrack,
} from '../../src/media/D64DiskImage';
import {
  buildD64GcrTrack,
  decodeD64GcrTrack,
  decodeCommodoreGcr,
  D64_GCR_LAYOUT,
  d64SpeedZoneForTrack,
  encodeCommodoreGcr,
  encodeD64SectorToGcr,
} from '../../src/peripherals/drive1541/CommodoreGcr';

function createDiskWithId(id1: number, id2: number): D64DiskImage {
  const bytes = new Uint8Array(d64SectorCountThroughTrack(35) * D64_LAYOUT.sectorSize);
  const directoryOffset = d64SectorCountThroughTrack(17) * D64_LAYOUT.sectorSize;
  bytes[directoryOffset + D64_LAYOUT.directoryHeader.diskId1Offset] = id1;
  bytes[directoryOffset + D64_LAYOUT.directoryHeader.diskId2Offset] = id2;
  return new D64DiskImage(bytes);
}

describe('Commodore GCR', () => {
  it('matches the canonical 4-to-5 encoding vector for four zero bytes', () => {
    expect(encodeCommodoreGcr(Uint8Array.of(0, 0, 0, 0))).toEqual(
      Uint8Array.of(0x52, 0x94, 0xa5, 0x29, 0x4a),
    );
  });

  it('round-trips arbitrary complete GCR groups', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 4, maxLength: 256 }), (source) => {
        const completeLength = source.length - (source.length % 4);
        if (completeLength === 0) return;
        const completeGroups = source.slice(0, completeLength);
        expect(decodeCommodoreGcr(encodeCommodoreGcr(completeGroups))).toEqual(completeGroups);
      }),
      { numRuns: 500 },
    );
  });

  it('rejects partial groups and illegal 5-bit symbols instead of decoding them as zero', () => {
    expect(() => encodeCommodoreGcr(Uint8Array.of(1, 2, 3))).toThrow(/divisible by 4/);
    expect(() => decodeCommodoreGcr(Uint8Array.of(1, 2, 3, 4))).toThrow(/divisible by 5/);
    expect(() => decodeCommodoreGcr(new Uint8Array(5))).toThrow(/Invalid Commodore GCR code/);
  });

  it('constructs decodable header and data blocks with exact checksums', () => {
    const sector = Uint8Array.from({ length: 256 }, (_, index) => index);
    const encoded = encodeD64SectorToGcr(sector, {
      id1: 0x4a,
      id2: 0x53,
      sector: 3,
      track: 18,
    });
    const headerOffset = D64_GCR_LAYOUT.syncLength;
    const dataOffset = headerOffset + 10 + D64_GCR_LAYOUT.headerGapSize + D64_GCR_LAYOUT.syncLength;
    const header = decodeCommodoreGcr(encoded.slice(headerOffset, headerOffset + 10));
    const data = decodeCommodoreGcr(encoded.slice(dataOffset, dataOffset + 325));

    expect(header).toEqual(
      Uint8Array.of(0x08, 3 ^ 18 ^ 0x53 ^ 0x4a, 3, 18, 0x53, 0x4a, 0x0f, 0x0f),
    );
    expect(data[0]).toBe(0x07);
    expect(data.slice(1, 257)).toEqual(sector);
    expect(data[257]).toBe(0x00);
    expect(data.slice(258)).toEqual(Uint8Array.of(0, 0));
  });

  it('encodes D64 error-info conditions into the physical sync, marker, and checksum bytes', () => {
    const sector = new Uint8Array(256);
    const header = { id1: 1, id2: 2, sector: 0, track: 1 } as const;
    const noSync = encodeD64SectorToGcr(sector, header, D64_ERROR_CODE.syncNotFound);
    expect(noSync.slice(0, D64_GCR_LAYOUT.syncLength)).toEqual(
      new Uint8Array(D64_GCR_LAYOUT.syncLength).fill(D64_GCR_LAYOUT.fillByte),
    );

    const noData = encodeD64SectorToGcr(sector, header, D64_ERROR_CODE.dataBlockNotFound);
    const dataOffset =
      D64_GCR_LAYOUT.syncLength + 10 + D64_GCR_LAYOUT.headerGapSize + D64_GCR_LAYOUT.syncLength;
    expect(decodeCommodoreGcr(noData.slice(dataOffset, dataOffset + 325))[0]).toBe(0x00);

    const badChecksum = encodeD64SectorToGcr(sector, header, D64_ERROR_CODE.dataChecksum);
    expect(decodeCommodoreGcr(badChecksum.slice(dataOffset, dataOffset + 325))[257]).toBe(0xff);
  });

  it.each([
    ['header descriptor', D64_ERROR_CODE.headerNotFound],
    ['sync', D64_ERROR_CODE.syncNotFound],
    ['data descriptor', D64_ERROR_CODE.dataBlockNotFound],
    ['data checksum', D64_ERROR_CODE.dataChecksum],
    ['header checksum', D64_ERROR_CODE.headerChecksum],
    ['disk ID', D64_ERROR_CODE.diskIdMismatch],
  ] as const)('does not silently normalize a representable %s error', (_description, errorCode) => {
    const sector = new Uint8Array(256);
    const header = { id1: 1, id2: 2, sector: 0, track: 1 } as const;
    const normal = encodeD64SectorToGcr(sector, header);

    expect(encodeD64SectorToGcr(sector, header, errorCode)).not.toEqual(normal);
  });

  it.each([
    ['write verify', D64_ERROR_CODE.verify],
    ['write protection', D64_ERROR_CODE.writeProtected],
    ['data-block length', D64_ERROR_CODE.dataBlockLength],
    ['format speed', D64_ERROR_CODE.formatSpeed],
    ['drive not ready', D64_ERROR_CODE.drive],
    ['GCR decode', D64_ERROR_CODE.decode],
  ] as const)(
    'rejects the non-unique %s status instead of encoding a normal sector',
    (_description, errorCode) => {
      expect(() =>
        encodeD64SectorToGcr(
          new Uint8Array(256),
          { id1: 1, id2: 2, sector: 0, track: 1 },
          errorCode,
        ),
      ).toThrow(/does not define a unique passive GCR-sector representation/);
    },
  );

  it('builds exact speed-zone track lengths while leaving only physical gap bytes unused', () => {
    const disk = createDiskWithId(0x4a, 0x53);
    for (const track of [1, 18, 25, 31]) {
      const result = buildD64GcrTrack(disk, track);
      const zone = d64SpeedZoneForTrack(track);
      expect(result.speedZone).toBe(zone);
      expect(result.bytes).toHaveLength(D64_GCR_LAYOUT.rawTrackSizeBySpeedZone[zone]);
      expect(result.transferBitsPerSecond).toBe(
        D64_GCR_LAYOUT.transferBitsPerSecondBySpeedZone[zone],
      );
      expect(result.bytes.slice(-8)).toEqual(new Uint8Array(8).fill(0x55));
    }
  });

  it('recovers every checksummed sector from a raw track at an arbitrary bit phase', () => {
    const disk = createDiskWithId(0x4a, 0x53);
    const rawTrack = buildD64GcrTrack(disk, 18).bytes;
    const rotated = rotateTrackBits(rawTrack, 3);
    const decoded = decodeD64GcrTrack(rotated);
    const sectors = [...decoded.sectors].sort((left, right) => left.sector - right.sector);

    expect(decoded.issues).toEqual([]);
    expect(sectors).toHaveLength(disk.sectorsOnTrack(18));
    expect(sectors.map((sector) => sector.sector)).toEqual(
      Array.from({ length: disk.sectorsOnTrack(18) }, (_unused, sector) => sector),
    );
    expect(sectors.every((sector) => sector.track === 18)).toBe(true);
    expect(sectors.every((sector) => sector.id1 === 0x4a && sector.id2 === 0x53)).toBe(true);
    expect(sectors[0]?.data).toEqual(disk.readSector(18, 0));
  });

  it('ignores only the two non-semantic data-block padding bytes at a write splice', () => {
    const disk = createDiskWithId(0x4a, 0x53);
    const rawTrack = buildD64GcrTrack(disk, 18).bytes;
    const dataStartByte =
      D64_GCR_LAYOUT.syncLength + 10 + D64_GCR_LAYOUT.headerGapSize + D64_GCR_LAYOUT.syncLength;
    const paddingStartBit = dataStartByte * 8 + 258 * 10;

    // 两个填充字节占最后 20 个 GCR 位。写门关闭造成的非法尾符号不能否定此前已经由
    // marker、数据和 checksum 唯一确定的扇区内容。
    for (let bit = 0; bit < 20; bit += 1) writeTrackBit(rawTrack, paddingStartBit + bit, 0);

    const decoded = decodeD64GcrTrack(rawTrack);
    const sectorZero = decoded.sectors.find((sector) => sector.sector === 0);
    expect(sectorZero?.data).toEqual(disk.readSector(18, 0));
    expect(decoded.issues).toEqual([]);
  });
});

function rotateTrackBits(source: Uint8Array, shift: number): Uint8Array {
  const bitLength = source.length * 8;
  const result = new Uint8Array(source.length);
  for (let outputBit = 0; outputBit < bitLength; outputBit += 1) {
    const inputBit = (outputBit + shift) % bitLength;
    const inputByte = source[Math.floor(inputBit / 8)];
    if (inputByte === undefined)
      throw new RangeError('Test bit rotation exceeded the source track.');
    const value = (inputByte >>> (7 - (inputBit & 7))) & 1;
    const outputByteIndex = Math.floor(outputBit / 8);
    result[outputByteIndex] = (result[outputByteIndex] ?? 0) | (value << (7 - (outputBit & 7)));
  }
  return result;
}

function writeTrackBit(track: Uint8Array, bitOffset: number, value: 0 | 1): void {
  const byteIndex = Math.floor(bitOffset / 8);
  const previous = track[byteIndex];
  if (previous === undefined) throw new RangeError('Test bit write exceeded the raw track.');
  const mask = 1 << (7 - (bitOffset & 7));
  track[byteIndex] = value === 0 ? previous & ~mask : previous | mask;
}
