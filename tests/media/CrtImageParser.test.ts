// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CRT 卡带镜像解析测试
//
//   文件:       CrtImageParser.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { MagicDeskCartridge } from '../../src/core/memory/MagicDeskCartridge';
import { OceanCartridge } from '../../src/core/memory/OceanCartridge';
import { EasyFlashCartridge, EASY_FLASH_LAYOUT } from '../../src/core/memory/EasyFlashCartridge';
import {
  createCartridgeFromCrt,
  createStandardRomCartridgeFromCrt,
  CRT_CHIP_TYPE,
  CRT_HARDWARE_TYPE,
  parseCrtImage,
} from '../../src/media/CrtImageParser';

interface TestChip {
  readonly bank?: number;
  readonly data: Uint8Array;
  readonly loadAddress: number;
  readonly padding?: number;
  readonly type?: number;
}

interface TestCrtOptions {
  readonly chips: readonly TestChip[];
  readonly exromLineHigh: boolean;
  readonly gameLineHigh: boolean;
  readonly hardwareType?: number;
  readonly name?: string;
}

function createCrt(options: TestCrtOptions): Uint8Array {
  const headerSize = 0x40;
  const totalSize = options.chips.reduce(
    (size, chip) => size + 0x10 + chip.data.length + (chip.padding ?? 0),
    headerSize,
  );
  const bytes = new Uint8Array(totalSize);
  writeAscii(bytes, 0, 'C64 CARTRIDGE   ');
  writeUint32Be(bytes, 0x10, headerSize);
  writeUint16Be(bytes, 0x14, 0x0100);
  writeUint16Be(bytes, 0x16, options.hardwareType ?? 0);
  bytes[0x18] = options.exromLineHigh ? 1 : 0;
  bytes[0x19] = options.gameLineHigh ? 1 : 0;
  writeAscii(bytes, 0x20, options.name ?? 'TEST CARTRIDGE');

  let offset = headerSize;
  for (const chip of options.chips) {
    const packetLength = 0x10 + chip.data.length + (chip.padding ?? 0);
    writeAscii(bytes, offset, 'CHIP');
    writeUint32Be(bytes, offset + 0x04, packetLength);
    writeUint16Be(bytes, offset + 0x08, chip.type ?? 0);
    writeUint16Be(bytes, offset + 0x0a, chip.bank ?? 0);
    writeUint16Be(bytes, offset + 0x0c, chip.loadAddress);
    writeUint16Be(bytes, offset + 0x0e, chip.data.length);
    bytes.set(chip.data, offset + 0x10);
    offset += packetLength;
  }
  return bytes;
}

function filledBytes(size: number, value: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.fill(value);
  return bytes;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function writeUint16Be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32Be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

describe('CrtImageParser', () => {
  it('parses the big-endian header, CHIP metadata, payload, and packet padding', () => {
    const file = createCrt({
      chips: [{ data: Uint8Array.of(0x10, 0x20, 0x30), loadAddress: 0x8000, padding: 5 }],
      exromLineHigh: false,
      gameLineHigh: true,
      name: 'GALAXY',
    });

    const image = parseCrtImage(file);

    expect(image.header).toMatchObject({
      exromLineHigh: false,
      gameLineHigh: true,
      hardwareType: 0,
      headerLength: 0x40,
      name: 'GALAXY',
      version: 0x0100,
    });
    expect(image.chips).toHaveLength(1);
    expect(image.chips[0]).toMatchObject({
      bank: 0,
      imageSize: 3,
      loadAddress: 0x8000,
      packetLength: 24,
      type: 0,
    });
    expect(image.chips[0]?.data).toEqual(Uint8Array.of(0x10, 0x20, 0x30));
  });

  it('creates an 8 KiB standard cartridge from physical GAME and EXROM levels', () => {
    const cartridge = createStandardRomCartridgeFromCrt(
      createCrt({
        chips: [{ data: filledBytes(0x2000, 0x81), loadAddress: 0x8000 }],
        exromLineHigh: false,
        gameLineHigh: true,
      }),
    );

    expect(cartridge.gameLineHigh).toBe(true);
    expect(cartridge.exromLineHigh).toBe(false);
    expect(cartridge.readRomLow(0x9fff)).toBe(0x81);
    expect(cartridge.readRomHigh(0xa000)).toBeNull();
  });

  it('splits a contiguous 16 KiB CHIP packet into ROML and ROMH', () => {
    const data = new Uint8Array(0x4000);
    data.fill(0x81, 0, 0x2000);
    data.fill(0xa1, 0x2000);
    const cartridge = createStandardRomCartridgeFromCrt(
      createCrt({
        chips: [{ data, loadAddress: 0x8000 }],
        exromLineHigh: false,
        gameLineHigh: false,
      }),
    );

    expect(cartridge.gameLineHigh).toBe(false);
    expect(cartridge.exromLineHigh).toBe(false);
    expect(cartridge.readRomLow(0x8000)).toBe(0x81);
    expect(cartridge.readRomHigh(0xa000)).toBe(0xa1);
  });

  it('assembles the non-contiguous Ultimax ROML and ROMH windows', () => {
    const cartridge = createStandardRomCartridgeFromCrt(
      createCrt({
        chips: [
          { data: filledBytes(0x2000, 0x88), loadAddress: 0x8000 },
          { data: filledBytes(0x2000, 0xe8), loadAddress: 0xe000 },
        ],
        exromLineHigh: true,
        gameLineHigh: false,
      }),
    );

    expect(cartridge.gameLineHigh).toBe(false);
    expect(cartridge.exromLineHigh).toBe(true);
    expect(cartridge.readRomLow(0x8000)).toBe(0x88);
    expect(cartridge.readRomHigh(0xe000)).toBe(0xe8);
  });

  it('creates a dense Ocean mapper from banked CRT CHIP packets', () => {
    const cartridge = createCartridgeFromCrt(
      createCrt({
        chips: Array.from({ length: 4 }, (_, bank) => ({
          bank,
          data: filledBytes(0x2000, 0x40 + bank),
          loadAddress: 0x8000,
        })),
        exromLineHigh: false,
        gameLineHigh: false,
        hardwareType: CRT_HARDWARE_TYPE.ocean,
      }),
    );

    expect(cartridge).toBeInstanceOf(OceanCartridge);
    cartridge.writeIo1(0xde00, 3);
    expect(cartridge.readRomLow(0x8000)).toBe(0x43);
    expect(cartridge.readRomHigh(0xa000)).toBe(0x43);
  });

  it('creates a Magic Desk mapper whose CRT reset lines match enabled 8K GAME mode', () => {
    const cartridge = createCartridgeFromCrt(
      createCrt({
        chips: Array.from({ length: 4 }, (_, bank) => ({
          bank,
          data: filledBytes(0x2000, 0x80 + bank),
          loadAddress: 0x8000,
        })),
        exromLineHigh: false,
        gameLineHigh: true,
        hardwareType: CRT_HARDWARE_TYPE.magicDesk,
      }),
    );

    expect(cartridge).toBeInstanceOf(MagicDeskCartridge);
    cartridge.writeIo1(0xde00, 2);
    expect(cartridge.readRomLow(0x8000)).toBe(0x82);
    cartridge.writeIo1(0xde00, 0x80);
    expect(cartridge.exromLineHigh).toBe(true);
  });

  it('assembles sparse EasyFlash CHIP packets into independent low and high flash chips', () => {
    const bankThree = new Uint8Array(EASY_FLASH_LAYOUT.bankSizeBytes * 2);
    bankThree.fill(0x33, 0, EASY_FLASH_LAYOUT.bankSizeBytes);
    bankThree.fill(0xb3, EASY_FLASH_LAYOUT.bankSizeBytes);
    const cartridge = createCartridgeFromCrt(
      createCrt({
        chips: [
          {
            bank: 3,
            data: bankThree,
            loadAddress: 0x8000,
            type: CRT_CHIP_TYPE.flash,
          },
          {
            bank: 63,
            data: filledBytes(EASY_FLASH_LAYOUT.bankSizeBytes, 0xef),
            loadAddress: 0xe000,
            type: CRT_CHIP_TYPE.flash,
          },
        ],
        exromLineHigh: true,
        gameLineHigh: false,
        hardwareType: CRT_HARDWARE_TYPE.easyFlash,
      }),
    );

    expect(cartridge).toBeInstanceOf(EasyFlashCartridge);
    cartridge.writeIo1(0xde00, 3);
    expect(cartridge.readRomLow(0x8000)).toBe(0x33);
    expect(cartridge.readRomHigh(0xe000)).toBe(0xb3);
    cartridge.writeIo1(0xde00, 4);
    expect(cartridge.readRomLow(0x8000)).toBe(0xff);
    expect(cartridge.readRomHigh(0xe000)).toBe(0xff);
    cartridge.writeIo1(0xde00, 63);
    expect(cartridge.readRomHigh(0xe000)).toBe(0xef);
  });

  it('rejects malformed signatures and truncated declared packets', () => {
    const badHeader = createCrt({
      chips: [{ data: filledBytes(0x2000, 0x81), loadAddress: 0x8000 }],
      exromLineHigh: false,
      gameLineHigh: true,
    });
    badHeader[0] = 0;
    expect(() => parseCrtImage(badHeader)).toThrow(/invalid signature/);

    const truncatedPacket = createCrt({
      chips: [{ data: Uint8Array.of(1, 2, 3), loadAddress: 0x8000 }],
      exromLineHigh: false,
      gameLineHigh: true,
    });
    writeUint32Be(truncatedPacket, 0x44, 0x1000);
    expect(() => parseCrtImage(truncatedPacket)).toThrow(/declared CRT CHIP packet/);
  });

  it('rejects ROM holes, overlapping packets, banked chips, and non-generic hardware', () => {
    const hole = createCrt({
      chips: [{ data: filledBytes(0x1000, 0x81), loadAddress: 0x8000 }],
      exromLineHigh: false,
      gameLineHigh: true,
    });
    expect(() => createStandardRomCartridgeFromCrt(hole)).toThrow(/does not drive ROML address/);

    const overlap = createCrt({
      chips: [
        { data: filledBytes(0x1800, 0x81), loadAddress: 0x8000 },
        { data: filledBytes(0x1000, 0x82), loadAddress: 0x9000 },
      ],
      exromLineHigh: false,
      gameLineHigh: true,
    });
    expect(() => createStandardRomCartridgeFromCrt(overlap)).toThrow(/overlap/);

    const banked = createCrt({
      chips: [{ bank: 1, data: filledBytes(0x2000, 0x81), loadAddress: 0x8000 }],
      exromLineHigh: false,
      gameLineHigh: true,
    });
    expect(() => createStandardRomCartridgeFromCrt(banked)).toThrow(/requires bank 0/);

    const hardwareSpecific = createCrt({
      chips: [{ data: filledBytes(0x2000, 0x81), loadAddress: 0x8000 }],
      exromLineHigh: false,
      gameLineHigh: true,
      hardwareType: 1,
    });
    expect(() => createStandardRomCartridgeFromCrt(hardwareSpecific)).toThrow(
      /not a standard ROM cartridge/,
    );
  });

  it('rejects missing mapper banks and unsupported hardware types', () => {
    const missingOceanBank = createCrt({
      chips: [0, 2, 3].map((bank) => ({
        bank,
        data: filledBytes(0x2000, 0x40 + bank),
        loadAddress: 0x8000,
      })),
      exromLineHigh: false,
      gameLineHigh: false,
      hardwareType: CRT_HARDWARE_TYPE.ocean,
    });
    expect(() => createCartridgeFromCrt(missingOceanBank)).toThrow(/missing ROM bank 1/);

    const hardwareSpecificLinesAreIgnored = createCrt({
      chips: Array.from({ length: 4 }, (_, bank) => ({
        bank,
        data: filledBytes(0x2000, bank),
        loadAddress: 0x8000,
      })),
      exromLineHigh: false,
      gameLineHigh: false,
      hardwareType: CRT_HARDWARE_TYPE.magicDesk,
    });
    const magicDesk = createCartridgeFromCrt(hardwareSpecificLinesAreIgnored);
    expect(magicDesk.gameLineHigh).toBe(true);
    expect(magicDesk.exromLineHigh).toBe(false);

    const unsupported = createCrt({
      chips: [{ data: filledBytes(0x2000, 0xff), loadAddress: 0x8000 }],
      exromLineHigh: false,
      gameLineHigh: true,
      hardwareType: 1,
    });
    expect(() => createCartridgeFromCrt(unsupported)).toThrow(/not implemented/);
  });

  it('rejects invalid EasyFlash CHIP types, locations, and overlapping flash ranges', () => {
    const wrongType = createCrt({
      chips: [{ data: filledBytes(0x2000, 0xff), loadAddress: 0x8000, type: 0 }],
      exromLineHigh: true,
      gameLineHigh: false,
      hardwareType: CRT_HARDWARE_TYPE.easyFlash,
    });
    expect(() => createCartridgeFromCrt(wrongType)).toThrow(/requires Flash CHIP/);

    const wrongAddress = createCrt({
      chips: [
        {
          data: filledBytes(0x2000, 0xff),
          loadAddress: 0xc000,
          type: CRT_CHIP_TYPE.flash,
        },
      ],
      exromLineHigh: true,
      gameLineHigh: false,
      hardwareType: CRT_HARDWARE_TYPE.easyFlash,
    });
    expect(() => createCartridgeFromCrt(wrongAddress)).toThrow(/invalid load address/);

    const overlap = createCrt({
      chips: [
        {
          bank: 2,
          data: filledBytes(0x4000, 0x22),
          loadAddress: 0x8000,
          type: CRT_CHIP_TYPE.flash,
        },
        {
          bank: 2,
          data: filledBytes(0x2000, 0x23),
          loadAddress: 0xa000,
          type: CRT_CHIP_TYPE.flash,
        },
      ],
      exromLineHigh: true,
      gameLineHigh: false,
      hardwareType: CRT_HARDWARE_TYPE.easyFlash,
    });
    expect(() => createCartridgeFromCrt(overlap)).toThrow(/overlapping CHIP data/);
  });
});
