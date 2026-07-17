// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CRT 卡带镜像解析
//
//   文件:       CrtImageParser.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { C64CartridgePort } from '../core/memory/C64CartridgePort';
import { BANKED_CARTRIDGE_ROM_LAYOUT } from '../core/memory/BankedCartridgeRom';
import { EasyFlashCartridge, EASY_FLASH_LAYOUT } from '../core/memory/EasyFlashCartridge';
import {
  MagicDeskCartridge,
  MAGIC_DESK_CARTRIDGE_BANK_COUNTS,
} from '../core/memory/MagicDeskCartridge';
import { OceanCartridge, OCEAN_CARTRIDGE_BANK_COUNTS } from '../core/memory/OceanCartridge';
import {
  C64_CARTRIDGE_MODE,
  c64CartridgeModeForLines,
  type C64CartridgeMode,
} from '../core/memory/C64Pla';
import {
  StandardRomCartridge,
  STANDARD_CARTRIDGE_ROM_LAYOUT,
} from '../core/memory/StandardRomCartridge';

const CRT_LAYOUT = {
  chip: {
    bankOffset: 0x0a,
    headerSize: 0x10,
    imageSizeOffset: 0x0e,
    loadAddressOffset: 0x0c,
    packetLengthOffset: 0x04,
    signature: 'CHIP',
    typeOffset: 0x08,
  },
  header: {
    exromOffset: 0x18,
    gameOffset: 0x19,
    hardwareSubtypeOffset: 0x1a,
    hardwareTypeOffset: 0x16,
    minimumSize: 0x40,
    nameLength: 0x20,
    nameOffset: 0x20,
    packetStartOffset: 0x10,
    signature: 'C64 CARTRIDGE   ',
    signatureLength: 0x10,
    versionOffset: 0x14,
  },
} as const;

export const CRT_CHIP_TYPE = {
  flash: 2,
  ram: 1,
  rom: 0,
} as const;

export const CRT_HARDWARE_TYPE = {
  easyFlash: 32,
  magicDesk: 19,
  ocean: 5,
  standard: 0,
} as const;

export interface CrtHeader {
  readonly exromLineHigh: boolean;
  readonly gameLineHigh: boolean;
  readonly hardwareSubtype: number;
  readonly hardwareType: number;
  readonly headerLength: number;
  readonly name: string;
  readonly version: number;
}

export interface CrtChipPacket {
  readonly bank: number;
  readonly data: Uint8Array;
  readonly imageSize: number;
  readonly loadAddress: number;
  readonly packetLength: number;
  readonly type: number;
}

export interface CrtImage {
  readonly chips: readonly CrtChipPacket[];
  readonly header: CrtHeader;
}

interface CartridgeAddressRange {
  readonly endExclusive: number;
  readonly image: Uint8Array;
  readonly occupied: Uint8Array;
  readonly signal: 'ROMH' | 'ROML';
  readonly start: number;
}

export function parseCrtImage(input: ArrayBuffer | Uint8Array): CrtImage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  requireAvailable(bytes, 0, CRT_LAYOUT.header.minimumSize, 'CRT header');
  requireSignature(bytes, 0, CRT_LAYOUT.header.signature, 'CRT header');

  const headerLength = readUint32Be(bytes, CRT_LAYOUT.header.packetStartOffset);
  if (headerLength < CRT_LAYOUT.header.minimumSize) {
    throw new RangeError(
      `CRT header length must be at least ${CRT_LAYOUT.header.minimumSize} bytes; received ${headerLength}.`,
    );
  }
  requireAvailable(bytes, 0, headerLength, 'declared CRT header');

  const exromLineHigh = readDigitalLine(bytes, CRT_LAYOUT.header.exromOffset, 'EXROM');
  const gameLineHigh = readDigitalLine(bytes, CRT_LAYOUT.header.gameOffset, 'GAME');
  const header: CrtHeader = {
    exromLineHigh,
    gameLineHigh,
    hardwareSubtype: readUint8(bytes, CRT_LAYOUT.header.hardwareSubtypeOffset),
    hardwareType: readUint16Be(bytes, CRT_LAYOUT.header.hardwareTypeOffset),
    headerLength,
    name: readFixedAscii(bytes, CRT_LAYOUT.header.nameOffset, CRT_LAYOUT.header.nameLength),
    version: readUint16Be(bytes, CRT_LAYOUT.header.versionOffset),
  };

  const chips: CrtChipPacket[] = [];
  let packetOffset = headerLength;
  while (packetOffset < bytes.length) {
    requireAvailable(bytes, packetOffset, CRT_LAYOUT.chip.headerSize, 'CRT CHIP header');
    requireSignature(bytes, packetOffset, CRT_LAYOUT.chip.signature, 'CRT CHIP packet');

    const packetLength = readUint32Be(bytes, packetOffset + CRT_LAYOUT.chip.packetLengthOffset);
    if (packetLength < CRT_LAYOUT.chip.headerSize) {
      throw new RangeError(
        `CRT CHIP packet at offset ${packetOffset} is shorter than its ${CRT_LAYOUT.chip.headerSize}-byte header.`,
      );
    }
    requireAvailable(bytes, packetOffset, packetLength, 'declared CRT CHIP packet');

    const imageSize = readUint16Be(bytes, packetOffset + CRT_LAYOUT.chip.imageSizeOffset);
    const imageOffset = packetOffset + CRT_LAYOUT.chip.headerSize;
    if (imageSize > packetLength - CRT_LAYOUT.chip.headerSize) {
      throw new RangeError(
        `CRT CHIP image at offset ${packetOffset} exceeds its declared packet length.`,
      );
    }
    const loadAddress = readUint16Be(bytes, packetOffset + CRT_LAYOUT.chip.loadAddressOffset);
    if (loadAddress + imageSize > 0x1_0000) {
      throw new RangeError(
        `CRT CHIP range $${loadAddress.toString(16)}..$${(loadAddress + imageSize - 1).toString(16)} crosses the 16-bit address space.`,
      );
    }

    chips.push({
      bank: readUint16Be(bytes, packetOffset + CRT_LAYOUT.chip.bankOffset),
      data: bytes.slice(imageOffset, imageOffset + imageSize),
      imageSize,
      loadAddress,
      packetLength,
      type: readUint16Be(bytes, packetOffset + CRT_LAYOUT.chip.typeOffset),
    });
    packetOffset += packetLength;
  }

  return { chips, header };
}

export function createCartridgeFromCrt(
  input: ArrayBuffer | Uint8Array | CrtImage,
): C64CartridgePort {
  const image = isCrtImage(input) ? input : parseCrtImage(input);
  switch (image.header.hardwareType) {
    case CRT_HARDWARE_TYPE.standard:
      return createStandardRomCartridgeFromCrt(image);
    case CRT_HARDWARE_TYPE.ocean:
      return createOceanCartridgeFromCrt(image);
    case CRT_HARDWARE_TYPE.magicDesk:
      return createMagicDeskCartridgeFromCrt(image);
    case CRT_HARDWARE_TYPE.easyFlash:
      return createEasyFlashCartridgeFromCrt(image);
    default:
      throw new RangeError(
        `CRT hardware type ${image.header.hardwareType} is not implemented by the cartridge factory.`,
      );
  }
}

export function createStandardRomCartridgeFromCrt(
  input: ArrayBuffer | Uint8Array | CrtImage,
): C64CartridgePort {
  const image = isCrtImage(input) ? input : parseCrtImage(input);
  if (image.header.hardwareType !== CRT_HARDWARE_TYPE.standard) {
    throw new RangeError(
      `CRT hardware type ${image.header.hardwareType} is not a standard ROM cartridge.`,
    );
  }
  if (image.chips.length === 0) throw new RangeError('CRT image contains no CHIP packets.');

  for (const chip of image.chips) {
    if (chip.type !== CRT_CHIP_TYPE.rom) {
      throw new RangeError(
        `Standard ROM cartridge cannot represent CHIP type ${chip.type} at $${chip.loadAddress.toString(16)}.`,
      );
    }
    if (chip.bank !== 0) {
      throw new RangeError(
        `Standard ROM cartridge requires bank 0; received bank ${chip.bank} at $${chip.loadAddress.toString(16)}.`,
      );
    }
    if (chip.imageSize === 0) throw new RangeError('CRT CHIP packets must not be empty.');
  }

  const mode = c64CartridgeModeForLines(image.header.gameLineHigh, image.header.exromLineHigh);
  return createStandardCartridgeForMode(mode, image.chips);
}

// CRT 规范只让 generic type 0 使用 header GAME/EXROM 初始化线路；硬件专用 mapper
// 的上电线路和后续切换由硬件类型及其寄存器定义。
export function createOceanCartridgeFromCrt(
  input: ArrayBuffer | Uint8Array | CrtImage,
): OceanCartridge {
  const image = isCrtImage(input) ? input : parseCrtImage(input);
  requireHardwareType(image, CRT_HARDWARE_TYPE.ocean, 'Ocean');
  const romBanks = assembleBankedRomChips(image.chips, 'Ocean', OCEAN_CARTRIDGE_BANK_COUNTS);
  return new OceanCartridge({ romBanks });
}

export function createMagicDeskCartridgeFromCrt(
  input: ArrayBuffer | Uint8Array | CrtImage,
): MagicDeskCartridge {
  const image = isCrtImage(input) ? input : parseCrtImage(input);
  requireHardwareType(image, CRT_HARDWARE_TYPE.magicDesk, 'Magic Desk');
  const romBanks = assembleBankedRomChips(
    image.chips,
    'Magic Desk',
    MAGIC_DESK_CARTRIDGE_BANK_COUNTS,
  );
  return new MagicDeskCartridge({ romBanks });
}

export function createEasyFlashCartridgeFromCrt(
  input: ArrayBuffer | Uint8Array | CrtImage,
): EasyFlashCartridge {
  const image = isCrtImage(input) ? input : parseCrtImage(input);
  requireHardwareType(image, CRT_HARDWARE_TYPE.easyFlash, 'EasyFlash');
  const { flashHigh, flashLow } = assembleEasyFlashChips(image.chips);
  return new EasyFlashCartridge({ flashHigh, flashLow });
}

function createStandardCartridgeForMode(
  mode: C64CartridgeMode,
  chips: readonly CrtChipPacket[],
): C64CartridgePort {
  const bankSize = STANDARD_CARTRIDGE_ROM_LAYOUT.bankSize;
  switch (mode) {
    case C64_CARTRIDGE_MODE.game8K: {
      const [romLow] = assembleCartridgeRanges(chips, [createRange('ROML', 0x8000, bankSize)]);
      if (!romLow) throw new RangeError('Internal CRT ROML assembly invariant failed.');
      return new StandardRomCartridge({ mode, romLow });
    }
    case C64_CARTRIDGE_MODE.game16K: {
      const [romLow, romHigh] = assembleCartridgeRanges(chips, [
        createRange('ROML', 0x8000, bankSize),
        createRange('ROMH', 0xa000, bankSize),
      ]);
      if (!romLow || !romHigh) {
        throw new RangeError('Internal CRT 16 KiB assembly invariant failed.');
      }
      return new StandardRomCartridge({ mode, romHigh, romLow });
    }
    case C64_CARTRIDGE_MODE.ultimax: {
      const [romLow, romHigh] = assembleCartridgeRanges(chips, [
        createRange('ROML', 0x8000, bankSize),
        createRange('ROMH', 0xe000, bankSize),
      ]);
      if (!romLow || !romHigh) {
        throw new RangeError('Internal CRT Ultimax assembly invariant failed.');
      }
      return new StandardRomCartridge({ mode, romHigh, romLow });
    }
    case C64_CARTRIDGE_MODE.detached:
      throw new RangeError(
        'CRT header leaves both GAME and EXROM high, so no cartridge is selected.',
      );
  }
}

function createRange(
  signal: CartridgeAddressRange['signal'],
  start: number,
  size: number,
): CartridgeAddressRange {
  return {
    endExclusive: start + size,
    image: new Uint8Array(size),
    occupied: new Uint8Array(size),
    signal,
    start,
  };
}

function assembleCartridgeRanges(
  chips: readonly CrtChipPacket[],
  ranges: readonly CartridgeAddressRange[],
): readonly Uint8Array[] {
  for (const chip of chips) {
    for (let index = 0; index < chip.imageSize; index += 1) {
      const address = chip.loadAddress + index;
      const target = ranges.find((range) => address >= range.start && address < range.endExclusive);
      if (!target) {
        throw new RangeError(
          `CRT CHIP byte at $${address.toString(16)} is outside the selected cartridge mode.`,
        );
      }
      const destination = address - target.start;
      if (target.occupied[destination] !== 0) {
        throw new RangeError(
          `CRT CHIP packets overlap in ${target.signal} at $${address.toString(16)}.`,
        );
      }
      target.image[destination] = chip.data[index]!;
      target.occupied[destination] = 1;
    }
  }

  for (const range of ranges) {
    const missing = range.occupied.indexOf(0);
    if (missing !== -1) {
      throw new RangeError(
        `CRT image does not drive ${range.signal} address $${(range.start + missing).toString(16)}.`,
      );
    }
  }
  return ranges.map((range) => range.image);
}

function assembleBankedRomChips(
  chips: readonly CrtChipPacket[],
  deviceName: string,
  supportedBankCounts: readonly number[],
): readonly Uint8Array[] {
  if (chips.length === 0) throw new RangeError(`${deviceName} CRT image contains no CHIP packets.`);
  const highestBank = Math.max(...chips.map(({ bank }) => bank));
  const bankCount = highestBank + 1;
  if (!supportedBankCounts.includes(bankCount)) {
    throw new RangeError(
      `${deviceName} CRT highest bank ${highestBank} implies unsupported bank count ${bankCount}.`,
    );
  }

  const banks = Array.from({ length: bankCount }, (): Uint8Array | undefined => undefined);
  for (const chip of chips) {
    if (chip.type !== CRT_CHIP_TYPE.rom) {
      throw new RangeError(
        `${deviceName} CRT requires ROM CHIP packets; bank ${chip.bank} has type ${chip.type}.`,
      );
    }
    if (chip.imageSize !== BANKED_CARTRIDGE_ROM_LAYOUT.bankSize) {
      throw new RangeError(
        `${deviceName} CRT bank ${chip.bank} must contain ` +
          `${BANKED_CARTRIDGE_ROM_LAYOUT.bankSize} bytes; received ${chip.imageSize}.`,
      );
    }
    if (chip.loadAddress !== 0x8000 && chip.loadAddress !== 0xa000) {
      throw new RangeError(
        `${deviceName} CRT bank ${chip.bank} has invalid load address ` +
          `$${chip.loadAddress.toString(16)}.`,
      );
    }
    if (banks[chip.bank]) {
      throw new RangeError(`${deviceName} CRT contains duplicate ROM bank ${chip.bank}.`);
    }
    banks[chip.bank] = chip.data;
  }

  return Array.from({ length: bankCount }, (_, index) => {
    const bank = banks[index];
    if (!bank) throw new RangeError(`${deviceName} CRT is missing ROM bank ${index}.`);
    return bank;
  });
}

interface EasyFlashChipImages {
  readonly flashHigh: Uint8Array;
  readonly flashLow: Uint8Array;
}

function assembleEasyFlashChips(chips: readonly CrtChipPacket[]): EasyFlashChipImages {
  const flashSize = EASY_FLASH_LAYOUT.bankCount * EASY_FLASH_LAYOUT.bankSizeBytes;
  const flashLow = new Uint8Array(flashSize).fill(0xff);
  const flashHigh = new Uint8Array(flashSize).fill(0xff);
  const occupiedLow = new Uint8Array(flashSize);
  const occupiedHigh = new Uint8Array(flashSize);

  for (const chip of chips) {
    if (chip.type !== CRT_CHIP_TYPE.flash) {
      throw new RangeError(
        `EasyFlash CRT requires Flash CHIP packets; bank ${chip.bank} has type ${chip.type}.`,
      );
    }
    if (chip.bank < 0 || chip.bank >= EASY_FLASH_LAYOUT.bankCount) {
      throw new RangeError(
        `EasyFlash CRT bank must be from 0 through ${EASY_FLASH_LAYOUT.bankCount - 1}; ` +
          `received ${chip.bank}.`,
      );
    }

    const bankOffset = chip.bank * EASY_FLASH_LAYOUT.bankSizeBytes;
    if (chip.imageSize === EASY_FLASH_LAYOUT.bankSizeBytes) {
      if (chip.loadAddress === 0x8000) {
        copyEasyFlashChip(chip, flashLow, occupiedLow, bankOffset, 0);
      } else if (chip.loadAddress === 0xa000 || chip.loadAddress === 0xe000) {
        copyEasyFlashChip(chip, flashHigh, occupiedHigh, bankOffset, 0);
      } else {
        throw new RangeError(
          `EasyFlash 8 KiB CHIP bank ${chip.bank} has invalid load address ` +
            `$${chip.loadAddress.toString(16)}.`,
        );
      }
      continue;
    }

    if (chip.imageSize === EASY_FLASH_LAYOUT.bankSizeBytes * 2 && chip.loadAddress === 0x8000) {
      copyEasyFlashChip(chip, flashLow, occupiedLow, bankOffset, 0);
      copyEasyFlashChip(chip, flashHigh, occupiedHigh, bankOffset, EASY_FLASH_LAYOUT.bankSizeBytes);
      continue;
    }

    throw new RangeError(
      `EasyFlash CRT bank ${chip.bank} must contain an 8 KiB CHIP at $8000/$A000/$E000 ` +
        `or a 16 KiB CHIP at $8000; received ${chip.imageSize} bytes at ` +
        `$${chip.loadAddress.toString(16)}.`,
    );
  }

  return { flashHigh, flashLow };
}

function copyEasyFlashChip(
  chip: CrtChipPacket,
  target: Uint8Array,
  occupied: Uint8Array,
  targetOffset: number,
  sourceOffset: number,
): void {
  const copyLength = Math.min(EASY_FLASH_LAYOUT.bankSizeBytes, chip.imageSize - sourceOffset);
  for (let index = 0; index < copyLength; index += 1) {
    const destination = targetOffset + index;
    if (occupied[destination] !== 0) {
      throw new RangeError(
        `EasyFlash CRT contains overlapping CHIP data in bank ${chip.bank} ` +
          `at flash offset $${destination.toString(16)}.`,
      );
    }
    target[destination] = chip.data[sourceOffset + index]!;
    occupied[destination] = 1;
  }
}

function requireHardwareType(image: CrtImage, expected: number, deviceName: string): void {
  if (image.header.hardwareType !== expected) {
    throw new RangeError(
      `CRT hardware type ${image.header.hardwareType} is not a ${deviceName} cartridge.`,
    );
  }
}

function isCrtImage(input: ArrayBuffer | Uint8Array | CrtImage): input is CrtImage {
  return !(input instanceof ArrayBuffer) && !(input instanceof Uint8Array);
}

function readDigitalLine(bytes: Uint8Array, offset: number, name: string): boolean {
  const value = readUint8(bytes, offset);
  if (value !== 0 && value !== 1) {
    throw new RangeError(`CRT ${name} line must be encoded as 0 or 1; received ${value}.`);
  }
  return value === 1;
}

function readFixedAscii(bytes: Uint8Array, offset: number, length: number): string {
  requireAvailable(bytes, offset, length, 'CRT cartridge name');
  let end = offset;
  const limit = offset + length;
  while (end < limit && bytes[end] !== 0) end += 1;
  let value = '';
  for (let index = offset; index < end; index += 1) value += String.fromCharCode(bytes[index]!);
  return value.trimEnd();
}

function requireSignature(
  bytes: Uint8Array,
  offset: number,
  expected: string,
  context: string,
): void {
  requireAvailable(bytes, offset, expected.length, `${context} signature`);
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) {
      throw new RangeError(`${context} has an invalid signature.`);
    }
  }
}

function requireAvailable(
  bytes: Uint8Array,
  offset: number,
  length: number,
  context: string,
): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
    throw new RangeError(`${context} requested an invalid byte range.`);
  }
  if (offset + length > bytes.length) {
    throw new RangeError(
      `${context} needs bytes ${offset}..${offset + length - 1}, but the file has ${bytes.length} bytes.`,
    );
  }
}

function readUint8(bytes: Uint8Array, offset: number): number {
  requireAvailable(bytes, offset, 1, 'CRT byte');
  return bytes[offset]!;
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  requireAvailable(bytes, offset, 2, 'CRT 16-bit field');
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  requireAvailable(bytes, offset, 4, 'CRT 32-bit field');
  return (
    bytes[offset]! * 0x1_000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}
