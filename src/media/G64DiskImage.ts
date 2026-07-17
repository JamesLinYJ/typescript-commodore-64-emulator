// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - G64 原始磁道镜像
//
//   文件:       G64DiskImage.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const G64_LAYOUT = {
  firstHalfTrack: 2,
  headerSize: 12,
  maximumHalfTrackCount: 84,
  maximumTrackLengthOffset: 10,
  signature: 'GCR-1541',
  signatureLength: 8,
  speedEntrySize: 4,
  supportedVersion: 0,
  trackCountOffset: 9,
  trackEntrySize: 4,
  trackOffsetTableOffset: 12,
  versionOffset: 8,
} as const;

export type G64SpeedZone = 0 | 1 | 2 | 3;

export interface G64ConstantSpeedMap {
  readonly kind: 'constant';
  readonly zone: G64SpeedZone;
}

export interface G64VariableSpeedMap {
  readonly kind: 'variable';
  /** 每个字节按高位到低位依次保存四个 GCR 字节的两位速度区编号。 */
  readonly packedZones: Uint8Array;
}

export type G64SpeedMap = G64ConstantSpeedMap | G64VariableSpeedMap;

export interface G64HalfTrack {
  readonly bytes: Uint8Array;
  readonly halfTrack: number;
  readonly speedMap: G64SpeedMap;
}

export interface G64DiskImageOptions {
  readonly writeProtected?: boolean;
}

interface StoredG64HalfTrack {
  readonly bytes: Uint8Array;
  speedMap: G64SpeedMap;
}

const G64_SIGNATURE_BYTES = Uint8Array.from(G64_LAYOUT.signature, (character) =>
  character.charCodeAt(0),
);

/**
 * 保存 1541 磁头实际读取的 GCR 字节流，而不是把它投影成 DOS 扇区。
 *
 * 表项 0 对应物理半轨 2（磁道 1.0），之后每项增加半轨。偏移均相对整个文件；零偏移
 * 明确表示该半轨未记录。可变速度表按最大轨长分配，因而即使实际轨较短也能无损重写。
 */
export class G64DiskImage {
  readonly maximumTrackLength: number;
  writeProtected: boolean;

  private halfTrackCountValue: number;
  private readonly halfTracks: (StoredG64HalfTrack | undefined)[];
  private readonly defaultSpeedMaps: G64SpeedMap[];

  constructor(input: ArrayBuffer | Uint8Array, options: G64DiskImageOptions = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    requireG64Header(bytes);

    this.halfTrackCountValue = requireHalfTrackCount(bytes[G64_LAYOUT.trackCountOffset]);
    this.maximumTrackLength = readUint16LittleEndian(bytes, G64_LAYOUT.maximumTrackLengthOffset);
    if (this.maximumTrackLength === 0) {
      throw new RangeError('G64 maximum track length must be greater than zero.');
    }

    const tableEnd = tableEndOffset(this.halfTrackCount);
    if (bytes.length < tableEnd) {
      throw new RangeError(
        `G64 header tables require ${tableEnd} bytes; received ${bytes.length}.`,
      );
    }

    this.writeProtected = options.writeProtected ?? false;
    this.halfTracks = Array.from({ length: this.halfTrackCount });
    this.defaultSpeedMaps = Array.from({ length: this.halfTrackCount });

    for (let index = 0; index < this.halfTrackCount; index += 1) {
      const trackOffset = readUint32LittleEndian(
        bytes,
        G64_LAYOUT.trackOffsetTableOffset + index * G64_LAYOUT.trackEntrySize,
      );
      const speedEntry = readUint32LittleEndian(
        bytes,
        speedTableOffset(this.halfTrackCount) + index * G64_LAYOUT.speedEntrySize,
      );
      const speedMap = this.parseSpeedMap(bytes, speedEntry, index);
      this.defaultSpeedMaps[index] = speedMap;
      if (trackOffset === 0) continue;
      if (trackOffset < tableEnd) {
        throw new RangeError(
          `G64 half-track ${index + G64_LAYOUT.firstHalfTrack} points inside the header tables.`,
        );
      }

      const trackLength = readUint16LittleEndian(bytes, trackOffset);
      if (trackLength === 0 || trackLength > this.maximumTrackLength) {
        throw new RangeError(
          `G64 half-track ${index + G64_LAYOUT.firstHalfTrack} declares invalid length ${trackLength}; maximum is ${this.maximumTrackLength}.`,
        );
      }
      const dataStart = trackOffset + 2;
      const dataEnd = dataStart + trackLength;
      if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.length) {
        throw new RangeError(
          `G64 half-track ${index + G64_LAYOUT.firstHalfTrack} data extends beyond the image.`,
        );
      }
      this.halfTracks[index] = {
        bytes: bytes.slice(dataStart, dataEnd),
        speedMap,
      };
    }
  }

  get firstHalfTrack(): number {
    return G64_LAYOUT.firstHalfTrack;
  }

  get halfTrackCount(): number {
    return this.halfTrackCountValue;
  }

  get lastHalfTrack(): number {
    return G64_LAYOUT.firstHalfTrack + this.halfTrackCount - 1;
  }

  hasHalfTrack(halfTrack: number): boolean {
    const index = this.optionalHalfTrackIndex(halfTrack);
    return index !== undefined && this.halfTracks[index] !== undefined;
  }

  readHalfTrack(halfTrack: number): G64HalfTrack | undefined {
    const index = this.optionalHalfTrackIndex(halfTrack);
    if (index === undefined) return undefined;
    const stored = this.halfTracks[index];
    if (!stored) return undefined;
    return {
      bytes: stored.bytes.slice(),
      halfTrack,
      speedMap: cloneSpeedMap(stored.speedMap),
    };
  }

  speedZoneAtByte(halfTrack: number, byteIndex: number): G64SpeedZone {
    const physicalIndex = this.requirePhysicalHalfTrackIndex(halfTrack);
    const index = physicalIndex < this.halfTrackCount ? physicalIndex : undefined;
    const stored = index === undefined ? undefined : this.halfTracks[index];
    const speedMap = stored?.speedMap ??
      (index === undefined ? undefined : this.defaultSpeedMaps[index]) ?? {
        kind: 'constant',
        zone: defaultSpeedZoneForHalfTrack(halfTrack),
      };
    if (!Number.isInteger(byteIndex) || byteIndex < 0 || byteIndex >= this.maximumTrackLength) {
      throw new RangeError(
        `G64 speed-map byte index must be from 0 through ${this.maximumTrackLength - 1}.`,
      );
    }
    if (speedMap.kind === 'constant') return speedMap.zone;

    const packed = speedMap.packedZones[Math.trunc(byteIndex / 4)];
    if (packed === undefined) {
      throw new RangeError(`G64 variable speed map is missing byte ${Math.trunc(byteIndex / 4)}.`);
    }
    const shift = 6 - (byteIndex % 4) * 2;
    return ((packed >>> shift) & 0x03) as G64SpeedZone;
  }

  setHalfTrack(halfTrack: number, data: Uint8Array, speedMap?: G64SpeedMap): void {
    this.requireWritable();
    const index = this.ensureHalfTrackIndex(halfTrack);
    if (data.length === 0 || data.length > this.maximumTrackLength) {
      throw new RangeError(
        `G64 half-track data must contain 1..${this.maximumTrackLength} bytes; received ${data.length}.`,
      );
    }
    const selectedSpeedMap = speedMap ?? this.defaultSpeedMaps[index];
    if (!selectedSpeedMap) {
      throw new RangeError(`G64 half-track ${halfTrack} has no speed-map entry.`);
    }
    const normalizedSpeedMap = this.requireSpeedMap(selectedSpeedMap);
    this.defaultSpeedMaps[index] = normalizedSpeedMap;
    this.halfTracks[index] = {
      bytes: data.slice(),
      speedMap: normalizedSpeedMap,
    };
  }

  writeHalfTrackByte(
    halfTrack: number,
    byteIndex: number,
    value: number,
    speedZone?: G64SpeedZone,
  ): void {
    this.requireWritable();
    const index = this.requireHalfTrackIndex(halfTrack);
    const stored = this.halfTracks[index];
    if (!stored) throw new Error(`G64 half-track ${halfTrack} has not been recorded.`);
    if (!Number.isInteger(byteIndex) || byteIndex < 0 || byteIndex >= stored.bytes.length) {
      throw new RangeError(
        `G64 half-track ${halfTrack} byte index must be from 0 through ${stored.bytes.length - 1}.`,
      );
    }
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`G64 track writes require one byte; received ${String(value)}.`);
    }
    stored.bytes[byteIndex] = value;
    if (speedZone !== undefined) this.setStoredSpeedZoneAtByte(index, byteIndex, speedZone);
  }

  toBytes(): Uint8Array {
    const variableSpeedLength = this.variableSpeedMapLength;
    const trackBlockLength = 2 + this.maximumTrackLength;
    let outputLength = tableEndOffset(this.halfTrackCount);
    for (let index = 0; index < this.halfTrackCount; index += 1) {
      const track = this.halfTracks[index];
      const speedMap = track?.speedMap ?? this.defaultSpeedMaps[index];
      if (!speedMap) throw new RangeError(`G64 speed-map entry ${index} is missing.`);
      if (track) outputLength = checkedAdd(outputLength, trackBlockLength);
      if (speedMap.kind === 'variable') {
        outputLength = checkedAdd(outputLength, variableSpeedLength);
      }
    }
    const output = new Uint8Array(outputLength);
    output.set(G64_SIGNATURE_BYTES);
    output[G64_LAYOUT.versionOffset] = G64_LAYOUT.supportedVersion;
    output[G64_LAYOUT.trackCountOffset] = this.halfTrackCount;
    writeUint16LittleEndian(output, G64_LAYOUT.maximumTrackLengthOffset, this.maximumTrackLength);

    let nextBlockOffset = tableEndOffset(this.halfTrackCount);
    for (let index = 0; index < this.halfTrackCount; index += 1) {
      const track = this.halfTracks[index];
      const speedMap = track?.speedMap ?? this.defaultSpeedMaps[index];
      if (!speedMap) throw new RangeError(`G64 speed-map entry ${index} is missing.`);

      if (track) {
        writeUint32LittleEndian(
          output,
          G64_LAYOUT.trackOffsetTableOffset + index * G64_LAYOUT.trackEntrySize,
          nextBlockOffset,
        );
        writeUint16LittleEndian(output, nextBlockOffset, track.bytes.length);
        output.set(track.bytes, nextBlockOffset + 2);
        nextBlockOffset += trackBlockLength;
      }

      const speedOffset = speedTableOffset(this.halfTrackCount) + index * G64_LAYOUT.speedEntrySize;
      if (speedMap.kind === 'constant') {
        writeUint32LittleEndian(output, speedOffset, speedMap.zone);
      } else {
        writeUint32LittleEndian(output, speedOffset, nextBlockOffset);
        output.set(speedMap.packedZones, nextBlockOffset);
        nextBlockOffset += variableSpeedLength;
      }
    }
    return output;
  }

  private get variableSpeedMapLength(): number {
    return Math.ceil(this.maximumTrackLength / 4);
  }

  private parseSpeedMap(bytes: Uint8Array, entry: number, index: number): G64SpeedMap {
    if (entry <= 3) return { kind: 'constant', zone: entry as G64SpeedZone };
    const end = entry + this.variableSpeedMapLength;
    if (
      !Number.isSafeInteger(end) ||
      entry < tableEndOffset(this.halfTrackCount) ||
      end > bytes.length
    ) {
      throw new RangeError(
        `G64 half-track ${index + G64_LAYOUT.firstHalfTrack} speed map extends beyond the image.`,
      );
    }
    return { kind: 'variable', packedZones: bytes.slice(entry, end) };
  }

  private requireSpeedMap(speedMap: G64SpeedMap): G64SpeedMap {
    if (speedMap.kind === 'constant') {
      if (!isG64SpeedZone(speedMap.zone)) {
        throw new RangeError(`G64 constant speed zone ${String(speedMap.zone)} is invalid.`);
      }
      return { kind: 'constant', zone: speedMap.zone };
    }
    if (speedMap.packedZones.length !== this.variableSpeedMapLength) {
      throw new RangeError(
        `G64 variable speed map requires ${this.variableSpeedMapLength} bytes; received ${speedMap.packedZones.length}.`,
      );
    }
    return { kind: 'variable', packedZones: speedMap.packedZones.slice() };
  }

  private setStoredSpeedZoneAtByte(
    halfTrackIndex: number,
    byteIndex: number,
    speedZone: G64SpeedZone,
  ): void {
    if (!isG64SpeedZone(speedZone)) {
      throw new RangeError(`G64 write speed zone ${String(speedZone)} is invalid.`);
    }
    const stored = this.halfTracks[halfTrackIndex];
    if (!stored) throw new RangeError(`G64 half-track index ${halfTrackIndex} is not recorded.`);
    if (stored.speedMap.kind === 'constant' && stored.speedMap.zone === speedZone) return;

    if (stored.speedMap.kind === 'constant') {
      // 00/01/10/11 重复四次分别形成 $00/$55/$AA/$FF。
      const packedValue = stored.speedMap.zone * 0x55;
      stored.speedMap = {
        kind: 'variable',
        packedZones: new Uint8Array(this.variableSpeedMapLength).fill(packedValue),
      };
    }
    const packedIndex = Math.trunc(byteIndex / 4);
    const shift = 6 - (byteIndex % 4) * 2;
    const previous = stored.speedMap.packedZones[packedIndex];
    if (previous === undefined) {
      throw new RangeError(`G64 variable speed map is missing byte ${packedIndex}.`);
    }
    stored.speedMap.packedZones[packedIndex] = (previous & ~(0x03 << shift)) | (speedZone << shift);
    this.defaultSpeedMaps[halfTrackIndex] = stored.speedMap;
  }

  private requireHalfTrackIndex(halfTrack: number): number {
    const index = this.requirePhysicalHalfTrackIndex(halfTrack);
    if (index >= this.halfTrackCount) {
      throw new RangeError(
        `G64 half-track must be an integer from ${this.firstHalfTrack} through ${this.lastHalfTrack}.`,
      );
    }
    return index;
  }

  private optionalHalfTrackIndex(halfTrack: number): number | undefined {
    const index = this.requirePhysicalHalfTrackIndex(halfTrack);
    return index < this.halfTrackCount ? index : undefined;
  }

  private ensureHalfTrackIndex(halfTrack: number): number {
    const index = this.requirePhysicalHalfTrackIndex(halfTrack);
    while (this.halfTracks.length <= index) {
      const nextHalfTrack = G64_LAYOUT.firstHalfTrack + this.halfTracks.length;
      this.halfTracks.push(undefined);
      this.defaultSpeedMaps.push({
        kind: 'constant',
        zone: defaultSpeedZoneForHalfTrack(nextHalfTrack),
      });
    }
    this.halfTrackCountValue = Math.max(this.halfTrackCountValue, index + 1);
    return index;
  }

  private requirePhysicalHalfTrackIndex(halfTrack: number): number {
    const maximumHalfTrack = G64_LAYOUT.firstHalfTrack + G64_LAYOUT.maximumHalfTrackCount - 1;
    if (
      !Number.isInteger(halfTrack) ||
      halfTrack < G64_LAYOUT.firstHalfTrack ||
      halfTrack > maximumHalfTrack
    ) {
      throw new RangeError(
        `G64 physical half-track must be an integer from ${G64_LAYOUT.firstHalfTrack} through ${maximumHalfTrack}.`,
      );
    }
    return halfTrack - G64_LAYOUT.firstHalfTrack;
  }

  private requireWritable(): void {
    if (this.writeProtected) throw new Error('G64 image is write-protected.');
  }
}

export function isG64SpeedZone(value: number): value is G64SpeedZone {
  return Number.isInteger(value) && value >= 0 && value <= 3;
}

function defaultSpeedZoneForHalfTrack(halfTrack: number): G64SpeedZone {
  const track = Math.floor(halfTrack / 2);
  if (track <= 17) return 3;
  if (track <= 24) return 2;
  if (track <= 30) return 1;
  return 0;
}

function requireG64Header(bytes: Uint8Array): void {
  if (bytes.length < G64_LAYOUT.headerSize) {
    throw new RangeError(
      `G64 image requires a ${G64_LAYOUT.headerSize}-byte header; received ${bytes.length}.`,
    );
  }
  for (let index = 0; index < G64_SIGNATURE_BYTES.length; index += 1) {
    if (bytes[index] !== G64_SIGNATURE_BYTES[index]) {
      throw new RangeError(`G64 image does not begin with ${G64_LAYOUT.signature}.`);
    }
  }
  const version = bytes[G64_LAYOUT.versionOffset];
  if (version !== G64_LAYOUT.supportedVersion) {
    throw new RangeError(
      `Unsupported G64 version ${String(version)}; expected ${G64_LAYOUT.supportedVersion}.`,
    );
  }
}

function requireHalfTrackCount(value: number | undefined): number {
  if (value === undefined || value < 1 || value > G64_LAYOUT.maximumHalfTrackCount) {
    throw new RangeError(
      `G64 half-track count must be from 1 through ${G64_LAYOUT.maximumHalfTrackCount}; received ${String(value)}.`,
    );
  }
  return value;
}

function speedTableOffset(halfTrackCount: number): number {
  return G64_LAYOUT.trackOffsetTableOffset + halfTrackCount * G64_LAYOUT.trackEntrySize;
}

function tableEndOffset(halfTrackCount: number): number {
  return speedTableOffset(halfTrackCount) + halfTrackCount * G64_LAYOUT.speedEntrySize;
}

function cloneSpeedMap(speedMap: G64SpeedMap): G64SpeedMap {
  return speedMap.kind === 'constant'
    ? { kind: 'constant', zone: speedMap.zone }
    : { kind: 'variable', packedZones: speedMap.packedZones.slice() };
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result > 0xffff_ffff) {
    throw new RangeError('G64 serialization exceeds the 32-bit file-offset range.');
  }
  return result;
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number {
  const low = bytes[offset];
  const high = bytes[offset + 1];
  if (low === undefined || high === undefined) {
    throw new RangeError(`G64 uint16 at offset ${offset} is incomplete.`);
  }
  return low | (high << 8);
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];
  const fourth = bytes[offset + 3];
  if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
    throw new RangeError(`G64 uint32 at offset ${offset} is incomplete.`);
  }
  return (first | (second << 8) | (third << 16) | (fourth * 0x01_00_00_00)) >>> 0;
}

function writeUint16LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32LittleEndian(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = Math.floor(value / 0x01_00_00_00) & 0xff;
}
