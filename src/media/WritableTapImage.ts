// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 可写 TAP 磁带镜像
//
//   文件:       WritableTapImage.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  TAP_IMAGE_LAYOUT,
  TAP_VERSION,
  TAP_VIDEO_STANDARD,
  tapSourceClockHz,
  type TapPulse,
  type TapVideoStandard,
} from './TapImageParser';

const TAP_C64_SYSTEM = 0;
const TAP_SHORT_PULSE_CYCLE_QUANTUM = 8;
const TAP_MAX_SHORT_PULSE_CYCLES = 0xff * TAP_SHORT_PULSE_CYCLE_QUANTUM;
const TAP_MAX_EXTENDED_PULSE_CYCLES = 0xff_ffff;
const TAP_MAX_DATA_LENGTH = 0xffff_ffff;

export interface WritableTapImageOptions {
  readonly videoStandard?: TapVideoStandard;
}

/**
 * TAP v1 可写介质。Datasette 负责从 WRITE 边沿测量时间，本类只保存精确脉宽并执行无损
 * 序列化；小于扩展记录阈值但不能被八整除的脉宽必须由录音电路先完成累计量化。
 */
export class WritableTapImage {
  readonly sourceClockHz: number;
  readonly version = TAP_VERSION.precise;
  readonly videoStandard: TapVideoStandard;
  readonly writable = true;

  private readonly pulseValues: TapPulse[] = [];
  private dataLength = 0;
  private totalSourceCyclesValue = 0;

  constructor(options: WritableTapImageOptions = {}) {
    this.videoStandard = options.videoStandard ?? TAP_VIDEO_STANDARD.pal;
    this.sourceClockHz = tapSourceClockHz(this.videoStandard);
  }

  get pulses(): readonly TapPulse[] {
    return this.pulseValues;
  }

  get totalSourceCycles(): number {
    return this.totalSourceCyclesValue;
  }

  appendPulse(sourceCycles: number): void {
    if (!Number.isSafeInteger(sourceCycles) || sourceCycles <= 0) {
      throw new RangeError('Recorded TAP pulse duration must be a positive safe integer.');
    }
    if (sourceCycles > TAP_MAX_EXTENDED_PULSE_CYCLES) {
      throw new RangeError(
        `Recorded TAP pulse duration ${sourceCycles} exceeds the 24-bit TAP v1 limit.`,
      );
    }

    const encodedLength = this.encodedLengthForPulse(sourceCycles);
    const nextDataLength = this.dataLength + encodedLength;
    if (nextDataLength > TAP_MAX_DATA_LENGTH) {
      throw new RangeError('Recorded TAP data exceeds the unsigned 32-bit file-format limit.');
    }
    const nextTotalSourceCycles = this.totalSourceCyclesValue + sourceCycles;
    if (!Number.isSafeInteger(nextTotalSourceCycles)) {
      throw new RangeError('Recorded TAP total duration exceeds exact JavaScript integer range.');
    }

    this.pulseValues.push({
      dataOffset: this.dataLength,
      encodedLength,
      sourceCycles,
    });
    this.dataLength = nextDataLength;
    this.totalSourceCyclesValue = nextTotalSourceCycles;
  }

  truncateAtPulse(pulseCount: number): void {
    if (!Number.isInteger(pulseCount) || pulseCount < 0 || pulseCount > this.pulseValues.length) {
      throw new RangeError(
        `Writable TAP pulse count must be from 0 through ${this.pulseValues.length}.`,
      );
    }
    if (pulseCount === this.pulseValues.length) return;

    let totalSourceCycles = 0;
    for (let index = 0; index < pulseCount; index += 1) {
      const pulse = this.pulseValues[index];
      if (!pulse) throw new RangeError(`Writable TAP pulse ${index} is missing.`);
      totalSourceCycles += pulse.sourceCycles;
    }
    const lastPulse = this.pulseValues[pulseCount - 1];
    this.dataLength = lastPulse ? lastPulse.dataOffset + lastPulse.encodedLength : 0;
    this.totalSourceCyclesValue = totalSourceCycles;
    this.pulseValues.length = pulseCount;
  }

  toBytes(): Uint8Array {
    const bytes = new Uint8Array(TAP_IMAGE_LAYOUT.headerSize + this.dataLength);
    bytes.set(Uint8Array.from(TAP_IMAGE_LAYOUT.magic, (character) => character.charCodeAt(0)));
    bytes[TAP_IMAGE_LAYOUT.versionOffset] = this.version;
    bytes[TAP_IMAGE_LAYOUT.systemOffset] = TAP_C64_SYSTEM;
    bytes[TAP_IMAGE_LAYOUT.videoStandardOffset] = this.videoStandard;
    new DataView(bytes.buffer).setUint32(TAP_IMAGE_LAYOUT.dataLengthOffset, this.dataLength, true);

    let offset = TAP_IMAGE_LAYOUT.headerSize;
    for (const pulse of this.pulseValues) {
      if (pulse.encodedLength === 1) {
        bytes[offset] = pulse.sourceCycles / TAP_SHORT_PULSE_CYCLE_QUANTUM;
        offset += 1;
      } else {
        bytes[offset] = 0;
        bytes[offset + 1] = pulse.sourceCycles & 0xff;
        bytes[offset + 2] = (pulse.sourceCycles >>> 8) & 0xff;
        bytes[offset + 3] = (pulse.sourceCycles >>> 16) & 0xff;
        offset += 4;
      }
    }
    return bytes;
  }

  private encodedLengthForPulse(sourceCycles: number): 1 | 4 {
    if (
      sourceCycles <= TAP_MAX_SHORT_PULSE_CYCLES &&
      sourceCycles % TAP_SHORT_PULSE_CYCLE_QUANTUM === 0
    ) {
      return 1;
    }
    return 4;
  }
}
