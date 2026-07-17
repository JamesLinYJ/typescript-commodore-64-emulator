// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Magic Desk 分页卡带测试
//
//   文件:       MagicDeskCartridge.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { C64Memory } from '../../src/core/memory/C64Memory';
import { MagicDeskCartridge } from '../../src/core/memory/MagicDeskCartridge';
import { createTestFirmware } from '../helpers/createTestSystem';

const CARTRIDGE_ROM_BANK_SIZE = 0x2000;

function createBanks(count: number): readonly Uint8Array[] {
  return Array.from({ length: count }, (_, bank) => {
    const image = new Uint8Array(CARTRIDGE_ROM_BANK_SIZE);
    image.fill(0x80 + bank);
    return image;
  });
}

describe('MagicDeskCartridge', () => {
  it('switches ROML banks and releases EXROM through the mirrored IO1 register', () => {
    const cartridge = new MagicDeskCartridge({ romBanks: createBanks(4) });
    const memory = new C64Memory(createTestFirmware(), { cartridge });
    memory.ram[0x8000] = 0x35;

    expect(memory.read(0x8000)).toBe(0x80);
    memory.write(0xde00, 0x02);
    expect(cartridge.selectedBank).toBe(2);
    expect(memory.read(0x8000)).toBe(0x82);

    memory.write(0xdeff, 0x83);
    expect(cartridge.enabled).toBe(false);
    expect(cartridge.exromLineHigh).toBe(true);
    expect(memory.read(0x8000)).toBe(0x35);

    // 卡带隐藏后 IO1 仍在 C64 I/O 窗口，可由软件重新拉低 EXROM。
    memory.write(0xde7a, 0x01);
    expect(cartridge.enabled).toBe(true);
    expect(memory.read(0x8000)).toBe(0x81);
    expect(cartridge.readIo1()).toBeNull();
  });

  it('returns to enabled bank zero on hardware reset', () => {
    const cartridge = new MagicDeskCartridge({ romBanks: createBanks(8) });
    cartridge.writeIo1(0xde00, 0x87);
    cartridge.reset();

    expect(cartridge.enabled).toBe(true);
    expect(cartridge.selectedBank).toBe(0);
    expect(cartridge.exromLineHigh).toBe(false);
  });

  it('rejects incomplete decoder-sized ROM populations', () => {
    expect(() => new MagicDeskCartridge({ romBanks: createBanks(6) })).toThrow(
      /4, 8, 16, 32, 64, or 128/,
    );
  });
});
