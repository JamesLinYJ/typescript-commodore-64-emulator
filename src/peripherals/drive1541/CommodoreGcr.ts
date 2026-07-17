// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 Commodore GCR 编解码
//
//   文件:       CommodoreGcr.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  D64DiskImage,
  D64_ERROR_CODE,
  d64SectorsOnTrack,
  type D64DiskId,
  type D64ErrorCode,
} from '../../media/D64DiskImage';

const GCR_NIBBLE_TO_CODE = [
  0x0a, 0x0b, 0x12, 0x13, 0x0e, 0x0f, 0x16, 0x17, 0x09, 0x19, 0x1a, 0x1b, 0x0d, 0x1d, 0x1e, 0x15,
] as const;

const GCR_CODE_TO_NIBBLE = createDecodeTable();

export const D64_GCR_LAYOUT = {
  dataBlockDecodedSize: 260,
  dataGapBySpeedZone: [9, 12, 17, 8] as const,
  decodedGroupSize: 4,
  encodedGroupSize: 5,
  encodedHeaderAndDataSize: 335,
  fillByte: 0x55,
  headerDecodedSize: 8,
  headerGapSize: 9,
  rawTrackSizeBySpeedZone: [6250, 6666, 7142, 7692] as const,
  syncByte: 0xff,
  syncLength: 5,
  transferBitsPerSecondBySpeedZone: [250_000, 266_667, 285_714, 307_692] as const,
} as const;

export interface D64GcrSectorHeader extends D64DiskId {
  readonly sector: number;
  readonly track: number;
}

export interface D64GcrTrack {
  readonly bytes: Uint8Array;
  readonly speedZone: 0 | 1 | 2 | 3;
  readonly track: number;
  readonly transferBitsPerSecond: number;
}

export interface DecodedD64GcrSector extends D64GcrSectorHeader {
  readonly data: Uint8Array;
  readonly headerBitOffset: number;
}

export interface D64GcrDecodeIssue {
  readonly bitOffset: number;
  readonly reason: string;
}

export interface D64GcrTrackDecodeResult {
  readonly issues: readonly D64GcrDecodeIssue[];
  readonly sectors: readonly DecodedD64GcrSector[];
}

export function encodeCommodoreGcr(source: Uint8Array): Uint8Array {
  if (source.length % D64_GCR_LAYOUT.decodedGroupSize !== 0) {
    throw new RangeError(
      `Commodore GCR input length must be divisible by 4; received ${source.length}.`,
    );
  }

  const encoded = new Uint8Array(
    (source.length / D64_GCR_LAYOUT.decodedGroupSize) * D64_GCR_LAYOUT.encodedGroupSize,
  );
  let outputIndex = 0;
  let bitBuffer = 0;
  let bufferedBits = 0;

  for (const value of source) {
    const highCode = GCR_NIBBLE_TO_CODE[value >>> 4];
    const lowCode = GCR_NIBBLE_TO_CODE[value & 0x0f];
    if (highCode === undefined || lowCode === undefined) {
      throw new RangeError(`Cannot encode byte ${value} as Commodore GCR.`);
    }
    for (const code of [highCode, lowCode]) {
      bitBuffer = (bitBuffer << 5) | code;
      bufferedBits += 5;
      if (bufferedBits >= 8) {
        bufferedBits -= 8;
        encoded[outputIndex] = (bitBuffer >>> bufferedBits) & 0xff;
        outputIndex += 1;
        bitBuffer &= bufferedBits === 0 ? 0 : (1 << bufferedBits) - 1;
      }
    }
  }

  if (bufferedBits !== 0 || outputIndex !== encoded.length) {
    throw new Error('Commodore GCR encoder ended with an incomplete 5-byte group.');
  }
  return encoded;
}

export function decodeCommodoreGcr(source: Uint8Array): Uint8Array {
  if (source.length % D64_GCR_LAYOUT.encodedGroupSize !== 0) {
    throw new RangeError(
      `Commodore GCR input length must be divisible by 5; received ${source.length}.`,
    );
  }

  const decoded = new Uint8Array(
    (source.length / D64_GCR_LAYOUT.encodedGroupSize) * D64_GCR_LAYOUT.decodedGroupSize,
  );
  let outputIndex = 0;
  let pendingHighNibble: number | undefined;
  let bitBuffer = 0;
  let bufferedBits = 0;

  for (const value of source) {
    bitBuffer = (bitBuffer << 8) | value;
    bufferedBits += 8;
    while (bufferedBits >= 5) {
      bufferedBits -= 5;
      const code = (bitBuffer >>> bufferedBits) & 0x1f;
      bitBuffer &= bufferedBits === 0 ? 0 : (1 << bufferedBits) - 1;
      const nibble = GCR_CODE_TO_NIBBLE[code];
      if (nibble === undefined || nibble < 0) {
        throw new RangeError(`Invalid Commodore GCR code ${code.toString(16).padStart(2, '0')}.`);
      }
      if (pendingHighNibble === undefined) {
        pendingHighNibble = nibble;
      } else {
        decoded[outputIndex] = (pendingHighNibble << 4) | nibble;
        outputIndex += 1;
        pendingHighNibble = undefined;
      }
    }
  }

  if (bufferedBits !== 0 || pendingHighNibble !== undefined || outputIndex !== decoded.length) {
    throw new Error('Commodore GCR decoder ended with an incomplete 4-byte group.');
  }
  return decoded;
}

export function encodeD64SectorToGcr(
  sectorData: Uint8Array,
  header: D64GcrSectorHeader,
  errorCode: D64ErrorCode = D64_ERROR_CODE.ok,
): Uint8Array {
  if (sectorData.length !== 0x0100) {
    throw new RangeError(`D64 GCR sectors require 256 bytes; received ${sectorData.length}.`);
  }
  const speedZone = d64SpeedZoneForTrack(header.track);
  const dataGapSize = D64_GCR_LAYOUT.dataGapBySpeedZone[speedZone];
  const output = new Uint8Array(
    D64_GCR_LAYOUT.encodedHeaderAndDataSize +
      D64_GCR_LAYOUT.headerGapSize +
      dataGapSize +
      D64_GCR_LAYOUT.syncLength * 2,
  );
  output.fill(D64_GCR_LAYOUT.fillByte);

  const syncByte =
    errorCode === D64_ERROR_CODE.syncNotFound ? D64_GCR_LAYOUT.fillByte : D64_GCR_LAYOUT.syncByte;
  let offset = 0;
  output.fill(syncByte, offset, offset + D64_GCR_LAYOUT.syncLength);
  offset += D64_GCR_LAYOUT.syncLength;

  const idMutation = errorCode === D64_ERROR_CODE.diskIdMismatch ? 0xff : 0x00;
  const headerChecksum =
    (errorCode === D64_ERROR_CODE.headerChecksum ? 0xff : 0x00) ^
    header.sector ^
    header.track ^
    header.id2 ^
    header.id1 ^
    idMutation;
  const decodedHeader = Uint8Array.of(
    errorCode === D64_ERROR_CODE.headerNotFound ? 0xff : 0x08,
    headerChecksum,
    header.sector,
    header.track,
    header.id2,
    header.id1 ^ idMutation,
    0x0f,
    0x0f,
  );
  const encodedHeader = encodeCommodoreGcr(decodedHeader);
  output.set(encodedHeader, offset);
  offset += encodedHeader.length + D64_GCR_LAYOUT.headerGapSize;

  output.fill(syncByte, offset, offset + D64_GCR_LAYOUT.syncLength);
  offset += D64_GCR_LAYOUT.syncLength;

  const decodedData = new Uint8Array(D64_GCR_LAYOUT.dataBlockDecodedSize);
  decodedData[0] = errorCode === D64_ERROR_CODE.dataBlockNotFound ? 0x00 : 0x07;
  decodedData.set(sectorData, 1);
  let dataChecksum = errorCode === D64_ERROR_CODE.dataChecksum ? 0xff : 0x00;
  for (const value of sectorData) dataChecksum ^= value;
  decodedData[257] = dataChecksum;
  const encodedData = encodeCommodoreGcr(decodedData);
  output.set(encodedData, offset);
  offset += encodedData.length + dataGapSize;

  if (offset !== output.length) {
    throw new Error(`D64 GCR sector assembly wrote ${offset} of ${output.length} bytes.`);
  }
  return output;
}

export function buildD64GcrTrack(image: D64DiskImage, track: number): D64GcrTrack {
  const sectorCount = image.sectorsOnTrack(track);
  const speedZone = d64SpeedZoneForTrack(track);
  const trackBytes = new Uint8Array(D64_GCR_LAYOUT.rawTrackSizeBySpeedZone[speedZone]);
  trackBytes.fill(D64_GCR_LAYOUT.fillByte);
  const diskId = image.diskId;
  let offset = 0;

  for (let sector = 0; sector < sectorCount; sector += 1) {
    const encoded = encodeD64SectorToGcr(
      image.readSector(track, sector),
      { ...diskId, sector, track },
      image.errorCode(track, sector),
    );
    if (offset + encoded.length > trackBytes.length) {
      throw new RangeError(
        `D64 track ${track} needs more than its ${trackBytes.length}-byte speed-zone capacity.`,
      );
    }
    trackBytes.set(encoded, offset);
    offset += encoded.length;
  }

  // 剩余字节保持 $55。真实磁盘的旋转起点没有固定相位，因此不人为加入任意轨道偏移。
  return {
    bytes: trackBytes,
    speedZone,
    track,
    transferBitsPerSecond: D64_GCR_LAYOUT.transferBitsPerSecondBySpeedZone[speedZone],
  };
}

/**
 * 从任意位相开始扫描完整原始磁道，并只返回校验通过的标准 D64 扇区。
 *
 * D64 无法保存间隙长度、扇区顺序或半轨磁通，因此该函数只负责识别可明确投影回
 * 256 字节扇区的数据；调用方必须显式决定是否接受这种格式边界。
 */
export function decodeD64GcrTrack(trackBytes: Uint8Array): D64GcrTrackDecodeResult {
  if (trackBytes.length === 0) throw new RangeError('Cannot decode an empty GCR track.');
  const payloadStarts = findSyncPayloadStarts(trackBytes);
  const issues: D64GcrDecodeIssue[] = [];
  const sectors: DecodedD64GcrSector[] = [];

  for (const [candidateIndex, bitOffset] of payloadStarts.entries()) {
    const header = decodeHeaderCandidate(trackBytes, bitOffset, issues);
    if (!header) continue;
    const dataBitOffset = payloadStarts[(candidateIndex + 1) % payloadStarts.length];
    if (dataBitOffset === undefined) {
      issues.push({ bitOffset, reason: 'Header has no following sync-delimited data block.' });
      continue;
    }
    const data = decodeDataCandidate(trackBytes, dataBitOffset, issues);
    if (!data) continue;
    sectors.push({
      ...header,
      data,
      headerBitOffset: bitOffset,
    });
  }
  return { issues, sectors };
}

export function d64SpeedZoneForTrack(track: number): 0 | 1 | 2 | 3 {
  if (!Number.isInteger(track) || track < 1 || track > 42) {
    throw new RangeError(`1541 D64 speed-zone track must be an integer from 1 through 42.`);
  }
  if (track <= 17) return 3;
  if (track <= 24) return 2;
  if (track <= 30) return 1;
  return 0;
}

function createDecodeTable(): Int8Array {
  const table = new Int8Array(32);
  table.fill(-1);
  for (let nibble = 0; nibble < GCR_NIBBLE_TO_CODE.length; nibble += 1) {
    const code = GCR_NIBBLE_TO_CODE[nibble];
    if (code !== undefined) table[code] = nibble;
  }
  return table;
}

function findSyncPayloadStarts(trackBytes: Uint8Array): number[] {
  const bitLength = trackBytes.length * 8;
  const starts: number[] = [];
  for (let bitOffset = 0; bitOffset < bitLength; bitOffset += 1) {
    if (readCyclicTrackBit(trackBytes, bitOffset) !== 0) continue;
    let precededBySync = true;
    for (let distance = 1; distance <= DRIVE_SYNC_DETECT_BITS; distance += 1) {
      if (readCyclicTrackBit(trackBytes, bitOffset - distance) === 0) {
        precededBySync = false;
        break;
      }
    }
    if (precededBySync) starts.push(bitOffset);
  }
  return starts;
}

const DRIVE_SYNC_DETECT_BITS = 10;

function decodeHeaderCandidate(
  trackBytes: Uint8Array,
  bitOffset: number,
  issues: D64GcrDecodeIssue[],
): D64GcrSectorHeader | undefined {
  let decoded: Uint8Array;
  try {
    decoded = decodeCommodoreGcr(readCyclicTrackBytes(trackBytes, bitOffset, 10));
  } catch {
    return undefined;
  }
  if (decoded[0] !== 0x08) return undefined;

  const checksum = decoded[1];
  const sector = decoded[2];
  const track = decoded[3];
  const id2 = decoded[4];
  const id1 = decoded[5];
  if (
    checksum === undefined ||
    sector === undefined ||
    track === undefined ||
    id2 === undefined ||
    id1 === undefined
  ) {
    issues.push({ bitOffset, reason: 'Decoded GCR header is incomplete.' });
    return undefined;
  }
  if (track < 1 || track > 42 || sector >= d64SectorsOnTrack(track)) {
    issues.push({
      bitOffset,
      reason: `Header identifies invalid track/sector ${track}/${sector}.`,
    });
    return undefined;
  }
  if (checksum !== (sector ^ track ^ id2 ^ id1)) {
    issues.push({
      bitOffset,
      reason: `Header checksum failed for track/sector ${track}/${sector}.`,
    });
    return undefined;
  }
  return { id1, id2, sector, track };
}

function decodeDataCandidate(
  trackBytes: Uint8Array,
  bitOffset: number,
  issues: D64GcrDecodeIssue[],
): Uint8Array | undefined {
  let decoded: Uint8Array;
  try {
    // 数据块最后两个解码字节是写入收尾填充，DOS 不把它们作为扇区内容或校验和。
    // 写门在块末关闭时可能留下不完整的最后一个 GCR 符号；只要标记、256 字节数据和
    // 校验和的前 258 个字节完整，就可以无歧义地投影回 D64 扇区。
    decoded = decodeCommodoreGcrPrefix(readCyclicTrackBytes(trackBytes, bitOffset, 325), 258);
  } catch (error: unknown) {
    issues.push({
      bitOffset,
      reason: `Data block contains illegal GCR: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
  if (decoded[0] !== 0x07) {
    issues.push({ bitOffset, reason: 'Header is not followed by a standard $07 data block.' });
    return undefined;
  }
  let checksum = 0;
  for (let index = 1; index <= 256; index += 1) {
    const value = decoded[index];
    if (value === undefined) {
      issues.push({ bitOffset, reason: 'Decoded GCR data block is incomplete.' });
      return undefined;
    }
    checksum ^= value;
  }
  if (decoded[257] !== checksum) {
    issues.push({ bitOffset, reason: 'Data block checksum does not match its 256-byte payload.' });
    return undefined;
  }
  return decoded.slice(1, 257);
}

function decodeCommodoreGcrPrefix(source: Uint8Array, decodedByteLength: number): Uint8Array {
  if (!Number.isInteger(decodedByteLength) || decodedByteLength <= 0) {
    throw new RangeError('Commodore GCR prefix length must be a positive integer.');
  }
  const requiredBitLength = decodedByteLength * 10;
  if (requiredBitLength > source.length * 8) {
    throw new RangeError(
      `Commodore GCR prefix needs ${requiredBitLength} bits; received ${source.length * 8}.`,
    );
  }

  const decoded = new Uint8Array(decodedByteLength);
  for (let index = 0; index < decodedByteLength; index += 1) {
    const highCode = readLinearBits(source, index * 10, 5);
    const lowCode = readLinearBits(source, index * 10 + 5, 5);
    const highNibble = GCR_CODE_TO_NIBBLE[highCode];
    const lowNibble = GCR_CODE_TO_NIBBLE[lowCode];
    if (highNibble === undefined || highNibble < 0) {
      throw new RangeError(`Invalid Commodore GCR code ${highCode.toString(16).padStart(2, '0')}.`);
    }
    if (lowNibble === undefined || lowNibble < 0) {
      throw new RangeError(`Invalid Commodore GCR code ${lowCode.toString(16).padStart(2, '0')}.`);
    }
    decoded[index] = (highNibble << 4) | lowNibble;
  }
  return decoded;
}

function readLinearBits(source: Uint8Array, bitOffset: number, bitCount: number): number {
  let result = 0;
  for (let bit = 0; bit < bitCount; bit += 1) {
    const absoluteBit = bitOffset + bit;
    const value = source[Math.floor(absoluteBit / 8)];
    if (value === undefined) throw new RangeError('GCR prefix bit offset exceeds its source.');
    result = (result << 1) | ((value >>> (7 - (absoluteBit & 7))) & 1);
  }
  return result;
}

function readCyclicTrackBytes(
  trackBytes: Uint8Array,
  startBitOffset: number,
  byteLength: number,
): Uint8Array {
  const result = new Uint8Array(byteLength);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value << 1) | readCyclicTrackBit(trackBytes, startBitOffset + byteIndex * 8 + bit);
    }
    result[byteIndex] = value;
  }
  return result;
}

function readCyclicTrackBit(trackBytes: Uint8Array, bitOffset: number): 0 | 1 {
  const bitLength = trackBytes.length * 8;
  const normalizedBitOffset = ((bitOffset % bitLength) + bitLength) % bitLength;
  const value = trackBytes[Math.floor(normalizedBitOffset / 8)];
  if (value === undefined) throw new RangeError('GCR bit offset resolved outside the track.');
  return ((value >>> (7 - (normalizedBitOffset & 7))) & 1) as 0 | 1;
}
