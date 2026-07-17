// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Ocean 分页卡带测试
//
//   文件:       OceanCartridge.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { OceanCartridge } from '../../src/core/memory/OceanCartridge';

const CARTRIDGE_ROM_BANK_SIZE = 0x2000;

function createBanks(count: number): readonly Uint8Array[] {
  return Array.from({ length: count }, (_, bank) => {
    const image = new Uint8Array(CARTRIDGE_ROM_BANK_SIZE);
    image.fill(0x40 + bank);
    return image;
  });
}

describe('OceanCartridge', () => {
  it('mirrors the selected Type A bank into ROML and ROMH', () => {
    const cartridge = new OceanCartridge({ romBanks: createBanks(16) });

    expect(cartridge.gameLineHigh).toBe(false);
    expect(cartridge.exromLineHigh).toBe(false);
    expect(cartridge.readRomLow(0x8000)).toBe(0x40);
    expect(cartridge.readRomHigh(0xa000)).toBe(0x40);
    cartridge.writeIo1(0xde7f, 0x8b);
    expect(cartridge.selectedBank).toBe(11);
    expect(cartridge.readRomLow(0x9fff)).toBe(0x4b);
    expect(cartridge.readRomHigh(0xbfff)).toBe(0x4b);
    expect(cartridge.readIo1()).toBeNull();

    cartridge.reset();
    expect(cartridge.selectedBank).toBe(0);
  });

  it('uses 8K GAME wiring for the 64-bank Type B board', () => {
    const cartridge = new OceanCartridge({ romBanks: createBanks(64) });

    expect(cartridge.gameLineHigh).toBe(true);
    expect(cartridge.exromLineHigh).toBe(false);
    cartridge.writeIo1(0xde00, 0xff);
    expect(cartridge.selectedBank).toBe(63);
    expect(cartridge.readRomLow(0x8000)).toBe(0x7f);
    expect(cartridge.readRomHigh(0xa000)).toBeNull();
  });

  it('rejects a ROM population that does not match a known Ocean decoder', () => {
    expect(() => new OceanCartridge({ romBanks: createBanks(8) })).toThrow(/4, 16, 32, or 64/);
  });
});
