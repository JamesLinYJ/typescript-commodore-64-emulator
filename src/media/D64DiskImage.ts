// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - D64 磁盘镜像
//
//   文件:       D64DiskImage.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const D64_LAYOUT = {
  directoryHeader: {
    diskId1Offset: 0xa2,
    diskId2Offset: 0xa3,
    sector: 0,
    track: 18,
  },
  maximumTrackCount: 42,
  minimumTrackCount: 35,
  sectorSize: 0x0100,
} as const;

export const D64_ERROR_CODE = {
  ok: 1,
  headerNotFound: 2,
  syncNotFound: 3,
  dataBlockNotFound: 4,
  dataChecksum: 5,
  verify: 7,
  writeProtected: 8,
  headerChecksum: 9,
  dataBlockLength: 10,
  diskIdMismatch: 11,
  formatSpeed: 12,
  drive: 15,
  decode: 16,
} as const;

export type D64ErrorCode = (typeof D64_ERROR_CODE)[keyof typeof D64_ERROR_CODE];

export interface D64DiskId {
  readonly id1: number;
  readonly id2: number;
}

export interface D64DiskImageOptions {
  readonly writeProtected?: boolean;
}

interface D64Geometry {
  readonly dataLength: number;
  readonly sectorCount: number;
  readonly trackCount: number;
}

export class D64DiskImage {
  readonly hasErrorInfo: boolean;
  readonly sectorCount: number;
  readonly trackCount: number;
  writeProtected: boolean;

  private readonly sectorData: Uint8Array;
  private readonly errorInfo: Uint8Array;

  constructor(input: ArrayBuffer | Uint8Array, options: D64DiskImageOptions = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const parsed = identifyGeometry(bytes.length);
    this.trackCount = parsed.geometry.trackCount;
    this.sectorCount = parsed.geometry.sectorCount;
    this.hasErrorInfo = parsed.hasErrorInfo;
    this.writeProtected = options.writeProtected ?? false;
    this.sectorData = bytes.slice(0, parsed.geometry.dataLength);
    this.errorInfo = parsed.hasErrorInfo
      ? bytes.slice(parsed.geometry.dataLength)
      : createDefaultErrorInfo(parsed.geometry.sectorCount);
    this.validateErrorInfo();
  }

  get diskId(): D64DiskId {
    const header = this.readSector(
      D64_LAYOUT.directoryHeader.track,
      D64_LAYOUT.directoryHeader.sector,
    );
    return {
      id1: header[D64_LAYOUT.directoryHeader.diskId1Offset]!,
      id2: header[D64_LAYOUT.directoryHeader.diskId2Offset]!,
    };
  }

  sectorsOnTrack(track: number): number {
    this.requireTrack(track);
    return d64SectorsOnTrack(track);
  }

  readSector(track: number, sector: number): Uint8Array {
    const index = this.sectorIndex(track, sector);
    const offset = index * D64_LAYOUT.sectorSize;
    return this.sectorData.slice(offset, offset + D64_LAYOUT.sectorSize);
  }

  writeSector(track: number, sector: number, data: Uint8Array): void {
    if (this.writeProtected) throw new Error('D64 image is write-protected.');
    if (data.length !== D64_LAYOUT.sectorSize) {
      throw new RangeError(
        `D64 sector writes require ${D64_LAYOUT.sectorSize} bytes; received ${data.length}.`,
      );
    }
    const index = this.sectorIndex(track, sector);
    this.sectorData.set(data, index * D64_LAYOUT.sectorSize);
    this.errorInfo[index] = D64_ERROR_CODE.ok;
  }

  errorCode(track: number, sector: number): D64ErrorCode {
    const code = this.errorInfo[this.sectorIndex(track, sector)];
    if (code === undefined || !isD64ErrorCode(code)) {
      throw new RangeError(`D64 sector has invalid error code ${String(code)}.`);
    }
    return code;
  }

  setErrorCode(track: number, sector: number, errorCode: D64ErrorCode): void {
    if (this.writeProtected) throw new Error('D64 image is write-protected.');
    if (!isD64ErrorCode(errorCode)) {
      throw new RangeError(`D64 error code ${String(errorCode)} is not defined by CBM DOS.`);
    }
    this.errorInfo[this.sectorIndex(track, sector)] = errorCode;
  }

  toBytes(includeErrorInfo = this.hasErrorInfo): Uint8Array {
    if (!includeErrorInfo) return this.sectorData.slice();
    const bytes = new Uint8Array(this.sectorData.length + this.errorInfo.length);
    bytes.set(this.sectorData);
    bytes.set(this.errorInfo, this.sectorData.length);
    return bytes;
  }

  private sectorIndex(track: number, sector: number): number {
    this.requireTrack(track);
    const sectors = d64SectorsOnTrack(track);
    if (!Number.isInteger(sector) || sector < 0 || sector >= sectors) {
      throw new RangeError(
        `D64 track ${track} contains sectors 0..${sectors - 1}; received sector ${sector}.`,
      );
    }
    return d64SectorCountThroughTrack(track - 1) + sector;
  }

  private requireTrack(track: number): void {
    if (!Number.isInteger(track) || track < 1 || track > this.trackCount) {
      throw new RangeError(
        `D64 image contains tracks 1..${this.trackCount}; received track ${track}.`,
      );
    }
  }

  private validateErrorInfo(): void {
    for (const [index, code] of this.errorInfo.entries()) {
      if (!isD64ErrorCode(code)) {
        throw new RangeError(`D64 error-info entry ${index} contains unsupported code ${code}.`);
      }
    }
  }
}

export function d64SectorsOnTrack(track: number): number {
  if (!Number.isInteger(track) || track < 1 || track > D64_LAYOUT.maximumTrackCount) {
    throw new RangeError(
      `D64 track must be an integer from 1 through ${D64_LAYOUT.maximumTrackCount}; received ${track}.`,
    );
  }
  if (track <= 17) return 21;
  if (track <= 24) return 19;
  if (track <= 30) return 18;
  return 17;
}

export function d64SectorCountThroughTrack(trackCount: number): number {
  if (
    !Number.isInteger(trackCount) ||
    trackCount < 0 ||
    trackCount > D64_LAYOUT.maximumTrackCount
  ) {
    throw new RangeError(
      `D64 track count must be an integer from 0 through ${D64_LAYOUT.maximumTrackCount}; received ${trackCount}.`,
    );
  }
  let sectors = 0;
  for (let track = 1; track <= trackCount; track += 1) sectors += d64SectorsOnTrack(track);
  return sectors;
}

export function isD64ErrorCode(value: number): value is D64ErrorCode {
  return Object.values(D64_ERROR_CODE).some((code) => code === value);
}

function identifyGeometry(fileLength: number): {
  readonly geometry: D64Geometry;
  readonly hasErrorInfo: boolean;
} {
  for (
    let trackCount = D64_LAYOUT.minimumTrackCount;
    trackCount <= D64_LAYOUT.maximumTrackCount;
    trackCount += 1
  ) {
    const sectorCount = d64SectorCountThroughTrack(trackCount);
    const dataLength = sectorCount * D64_LAYOUT.sectorSize;
    const geometry = { dataLength, sectorCount, trackCount } as const;
    if (fileLength === dataLength) return { geometry, hasErrorInfo: false };
    if (fileLength === dataLength + sectorCount) return { geometry, hasErrorInfo: true };
  }
  throw new RangeError(
    `Unsupported D64 size ${fileLength}; expected a 35..42-track image with optional error info.`,
  );
}

function createDefaultErrorInfo(sectorCount: number): Uint8Array {
  const errorInfo = new Uint8Array(sectorCount);
  errorInfo.fill(D64_ERROR_CODE.ok);
  return errorInfo;
}
