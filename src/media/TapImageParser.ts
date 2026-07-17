// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - TAP 磁带镜像解析
//
//   文件:       TapImageParser.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const TAP_IMAGE_LAYOUT = {
  dataLengthOffset: 16,
  headerSize: 20,
  magic: 'C64-TAPE-RAW',
  magicLength: 12,
  systemOffset: 13,
  versionOffset: 12,
  videoStandardOffset: 14,
} as const;

export const TAP_VERSION = {
  legacy: 0,
  precise: 1,
} as const;

export type TapVersion = (typeof TAP_VERSION)[keyof typeof TAP_VERSION];

export const TAP_VIDEO_STANDARD = {
  pal: 0,
  ntsc: 1,
  ntscOld: 2,
  palN: 3,
} as const;

export type TapVideoStandard = (typeof TAP_VIDEO_STANDARD)[keyof typeof TAP_VIDEO_STANDARD];

export interface TapPulse {
  readonly dataOffset: number;
  readonly encodedLength: number;
  readonly sourceCycles: number;
}

export interface TapImage {
  readonly pulses: readonly TapPulse[];
  readonly sourceClockHz: number;
  readonly totalSourceCycles: number;
  readonly version: TapVersion;
  readonly videoStandard: TapVideoStandard;
  readonly writable: false;
}

export interface TapImageParserOptions {
  /** TAP v0 的零字节只表示计数器溢出，格式本身没有保存真实脉冲长度。 */
  readonly legacyV0OverflowPulseCycles?: number;
}

const TAP_MAGIC_BYTES = Uint8Array.from(TAP_IMAGE_LAYOUT.magic, (character) =>
  character.charCodeAt(0),
);

const C64_SYSTEM = 0;
const SOURCE_CLOCK_HZ_BY_VIDEO_STANDARD = [985_248, 1_022_730, 1_022_730, 1_023_440] as const;

export function tapSourceClockHz(videoStandard: TapVideoStandard): number {
  const sourceClockHz = SOURCE_CLOCK_HZ_BY_VIDEO_STANDARD[videoStandard];
  if (sourceClockHz === undefined) {
    throw new RangeError(`TAP video standard ${videoStandard} has no source clock.`);
  }
  return sourceClockHz;
}

export function parseTapImage(
  input: ArrayBuffer | Uint8Array,
  options: TapImageParserOptions = {},
): TapImage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < TAP_IMAGE_LAYOUT.headerSize) {
    throw new RangeError(
      `TAP image requires a ${TAP_IMAGE_LAYOUT.headerSize}-byte header; received ${bytes.length} bytes.`,
    );
  }
  for (let index = 0; index < TAP_MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== TAP_MAGIC_BYTES[index]) {
      throw new RangeError(`TAP image does not begin with ${TAP_IMAGE_LAYOUT.magic}.`);
    }
  }

  const version = bytes[TAP_IMAGE_LAYOUT.versionOffset];
  if (version !== TAP_VERSION.legacy && version !== TAP_VERSION.precise) {
    throw new RangeError(
      `Unsupported C64 TAP version ${String(version)}; expected version 0 or 1.`,
    );
  }
  const system = bytes[TAP_IMAGE_LAYOUT.systemOffset];
  if (system !== C64_SYSTEM) {
    throw new RangeError(`TAP system ${String(system)} is not a Commodore 64 image.`);
  }
  const videoStandard = bytes[TAP_IMAGE_LAYOUT.videoStandardOffset];
  if (!isTapVideoStandard(videoStandard)) {
    throw new RangeError(`TAP video standard ${String(videoStandard)} is not defined.`);
  }

  const dataLength = readUint32LittleEndian(bytes, TAP_IMAGE_LAYOUT.dataLengthOffset);
  const expectedLength = TAP_IMAGE_LAYOUT.headerSize + dataLength;
  if (bytes.length !== expectedLength) {
    throw new RangeError(
      `TAP header declares ${dataLength} data bytes, but the file contains ${bytes.length - TAP_IMAGE_LAYOUT.headerSize}.`,
    );
  }

  const legacyOverflowCycles = options.legacyV0OverflowPulseCycles;
  if (
    legacyOverflowCycles !== undefined &&
    (!Number.isSafeInteger(legacyOverflowCycles) || legacyOverflowCycles <= 0)
  ) {
    throw new RangeError('Legacy TAP v0 overflow pulse length must be a positive safe integer.');
  }

  const pulses: TapPulse[] = [];
  let totalSourceCycles = 0;
  for (let offset = TAP_IMAGE_LAYOUT.headerSize; offset < bytes.length;) {
    const dataOffset = offset - TAP_IMAGE_LAYOUT.headerSize;
    const marker = bytes[offset];
    if (marker === undefined)
      throw new RangeError(`TAP pulse at data offset ${dataOffset} is missing.`);
    offset += 1;

    let sourceCycles: number;
    let encodedLength = 1;
    if (marker !== 0) {
      sourceCycles = marker * 8;
    } else if (version === TAP_VERSION.legacy) {
      if (legacyOverflowCycles === undefined) {
        throw new RangeError(
          `TAP v0 pulse at data offset ${dataOffset} overflowed; provide legacyV0OverflowPulseCycles explicitly.`,
        );
      }
      sourceCycles = legacyOverflowCycles;
    } else {
      if (offset + 3 > bytes.length) {
        throw new RangeError(`TAP v1 extended pulse at data offset ${dataOffset} is truncated.`);
      }
      sourceCycles = readUint24LittleEndian(bytes, offset);
      encodedLength = 4;
      offset += 3;
      if (sourceCycles === 0) {
        throw new RangeError(`TAP v1 extended pulse at data offset ${dataOffset} has zero length.`);
      }
    }

    totalSourceCycles += sourceCycles;
    if (!Number.isSafeInteger(totalSourceCycles)) {
      throw new RangeError('TAP total pulse duration exceeds exact JavaScript integer range.');
    }
    pulses.push({ dataOffset, encodedLength, sourceCycles });
  }

  const sourceClockHz = tapSourceClockHz(videoStandard);
  return {
    pulses,
    sourceClockHz,
    totalSourceCycles,
    version,
    videoStandard,
    writable: false,
  };
}

function isTapVideoStandard(value: number | undefined): value is TapVideoStandard {
  return value !== undefined && value >= TAP_VIDEO_STANDARD.pal && value <= TAP_VIDEO_STANDARD.palN;
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number): number {
  const low = bytes[offset];
  const middle = bytes[offset + 1];
  const high = bytes[offset + 2];
  if (low === undefined || middle === undefined || high === undefined) {
    throw new RangeError(`TAP uint24 at offset ${offset} is incomplete.`);
  }
  return low | (middle << 8) | (high << 16);
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  const low = bytes[offset];
  const middleLow = bytes[offset + 1];
  const middleHigh = bytes[offset + 2];
  const high = bytes[offset + 3];
  if (
    low === undefined ||
    middleLow === undefined ||
    middleHigh === undefined ||
    high === undefined
  ) {
    throw new RangeError(`TAP uint32 at offset ${offset} is incomplete.`);
  }
  return (low | (middleLow << 8) | (middleHigh << 16) | (high * 0x01_00_00_00)) >>> 0;
}
