// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Commodore ROM 磁带参考夹具
//
//   文件:       CommodoreRomTapeFixture.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { TAP_IMAGE_LAYOUT, TAP_VERSION, TAP_VIDEO_STANDARD } from '../../src/media/TapImageParser';

const ROM_TAPE_PULSE = {
  long: 0x56,
  medium: 0x42,
  short: 0x30,
} as const;

const ROM_TAPE_LAYOUT = {
  dataLeaderPulseCount: 0x1500,
  duplicateLeaderPulseCount: 0x4f,
  fileHeaderByteCount: 0xc0,
  fileNameByteCount: 0x10,
  firstLeaderPulseCount: 0x6a10,
  firstSyncStart: 0x89,
  headerEndAddressHighOffset: 0x04,
  headerEndAddressLowOffset: 0x03,
  headerFileNameOffset: 0x05,
  headerFileTypeOffset: 0x00,
  headerStartAddressHighOffset: 0x02,
  headerStartAddressLowOffset: 0x01,
  nonRelocatableFileType: 0x03,
  repeatedSyncStart: 0x09,
  syncByteCount: 0x09,
} as const;

const TAP_PULSE_CYCLE_QUANTUM = 8;
const PETSCII_SPACE = 0x20;

export interface CommodoreRomTapeFixtureOptions {
  readonly fileName: string;
  readonly loadAddress: number;
  readonly payload: Uint8Array;
}

/**
 * 构造 KERNAL SAVE 所使用的标准双副本磁带布局。夹具只编码脉冲，不复用项目的 TAP
 * 解析器或 CIA 路径，因此真实 ROM 必须自行完成同步、位判决、奇校验和块校验。
 */
export function createCommodoreRomTapeFixture(options: CommodoreRomTapeFixtureOptions): Uint8Array {
  validateOptions(options);

  const header = createFileHeader(options);
  const pulseData: number[] = [];
  appendBlockPair(pulseData, header, ROM_TAPE_LAYOUT.firstLeaderPulseCount);
  appendBlockPair(pulseData, options.payload, ROM_TAPE_LAYOUT.dataLeaderPulseCount);

  const image = new Uint8Array(TAP_IMAGE_LAYOUT.headerSize + pulseData.length);
  image.set(Uint8Array.from(TAP_IMAGE_LAYOUT.magic, (character) => character.charCodeAt(0)));
  image[TAP_IMAGE_LAYOUT.versionOffset] = TAP_VERSION.precise;
  image[TAP_IMAGE_LAYOUT.systemOffset] = 0;
  image[TAP_IMAGE_LAYOUT.videoStandardOffset] = TAP_VIDEO_STANDARD.pal;
  new DataView(image.buffer).setUint32(TAP_IMAGE_LAYOUT.dataLengthOffset, pulseData.length, true);
  image.set(pulseData, TAP_IMAGE_LAYOUT.headerSize);
  return image;
}

function appendBlockPair(output: number[], data: Uint8Array, firstLeaderCount: number): void {
  appendRepeatedPulse(output, ROM_TAPE_PULSE.short, firstLeaderCount);
  appendSync(output, ROM_TAPE_LAYOUT.firstSyncStart);
  appendChecksummedData(output, data);
  appendEndOfData(output);

  appendRepeatedPulse(output, ROM_TAPE_PULSE.short, ROM_TAPE_LAYOUT.duplicateLeaderPulseCount);
  appendSync(output, ROM_TAPE_LAYOUT.repeatedSyncStart);
  appendChecksummedData(output, data);
  appendEndOfData(output);
}

function appendSync(output: number[], firstValue: number): void {
  for (let offset = 0; offset < ROM_TAPE_LAYOUT.syncByteCount; offset += 1) {
    appendByte(output, firstValue - offset);
  }
}

function appendChecksummedData(output: number[], data: Uint8Array): void {
  let checksum = 0;
  for (const value of data) {
    appendByte(output, value);
    checksum ^= value;
  }
  appendByte(output, checksum);
}

function appendByte(output: number[], value: number): void {
  // 每个 ROM 字节先以 LONG/MEDIUM 标记边界，再按低位优先编码八位与一位奇校验。
  output.push(ROM_TAPE_PULSE.long, ROM_TAPE_PULSE.medium);
  let parityBit = 1;
  for (let bit = 0; bit < 8; bit += 1) {
    const one = (value & (1 << bit)) !== 0;
    appendBit(output, one);
    if (one) parityBit ^= 1;
  }
  appendBit(output, parityBit !== 0);
}

function appendBit(output: number[], one: boolean): void {
  if (one) output.push(ROM_TAPE_PULSE.medium, ROM_TAPE_PULSE.short);
  else output.push(ROM_TAPE_PULSE.short, ROM_TAPE_PULSE.medium);
}

function appendEndOfData(output: number[]): void {
  output.push(ROM_TAPE_PULSE.long, ROM_TAPE_PULSE.short);
}

function appendRepeatedPulse(output: number[], pulse: number, count: number): void {
  for (let index = 0; index < count; index += 1) output.push(pulse);
}

function createFileHeader(options: CommodoreRomTapeFixtureOptions): Uint8Array {
  const header = new Uint8Array(ROM_TAPE_LAYOUT.fileHeaderByteCount);
  header.fill(PETSCII_SPACE);
  const endAddress = options.loadAddress + options.payload.length;
  header[ROM_TAPE_LAYOUT.headerFileTypeOffset] = ROM_TAPE_LAYOUT.nonRelocatableFileType;
  header[ROM_TAPE_LAYOUT.headerStartAddressLowOffset] = options.loadAddress & 0xff;
  header[ROM_TAPE_LAYOUT.headerStartAddressHighOffset] = options.loadAddress >>> 8;
  header[ROM_TAPE_LAYOUT.headerEndAddressLowOffset] = endAddress & 0xff;
  header[ROM_TAPE_LAYOUT.headerEndAddressHighOffset] = endAddress >>> 8;
  for (let index = 0; index < options.fileName.length; index += 1) {
    header[ROM_TAPE_LAYOUT.headerFileNameOffset + index] = options.fileName.charCodeAt(index);
  }
  return header;
}

function validateOptions(options: CommodoreRomTapeFixtureOptions): void {
  if (
    options.fileName.length === 0 ||
    options.fileName.length > ROM_TAPE_LAYOUT.fileNameByteCount ||
    !/^[A-Z0-9 ]+$/.test(options.fileName)
  ) {
    throw new RangeError(
      'ROM tape fixture filename must contain 1 to 16 uppercase PETSCII characters.',
    );
  }
  if (!Number.isInteger(options.loadAddress) || options.loadAddress < 0) {
    throw new RangeError('ROM tape fixture load address must be a non-negative integer.');
  }
  if (options.payload.length === 0 || options.loadAddress + options.payload.length > 0x1_0000) {
    throw new RangeError('ROM tape fixture payload must fit inside the 16-bit address space.');
  }
  for (const pulse of Object.values(ROM_TAPE_PULSE)) {
    if (pulse <= 0 || pulse * TAP_PULSE_CYCLE_QUANTUM > 0xff * TAP_PULSE_CYCLE_QUANTUM) {
      throw new RangeError('ROM tape pulse cannot be represented by a one-byte TAP duration.');
    }
  }
}
