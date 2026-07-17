// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 标准 ROM 卡带测试
//
//   文件:       StandardRomCartridge.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { C64Memory } from '../../src/core/memory/C64Memory';
import { C64_CARTRIDGE_MODE } from '../../src/core/memory/C64Pla';
import {
  StandardRomCartridge,
  STANDARD_CARTRIDGE_ROM_LAYOUT,
} from '../../src/core/memory/StandardRomCartridge';
import { createTestFirmware } from '../helpers/createTestSystem';

function createRom(value: number): Uint8Array {
  const image = new Uint8Array(STANDARD_CARTRIDGE_ROM_LAYOUT.bankSize);
  image.fill(value);
  return image;
}

describe('StandardRomCartridge', () => {
  it('maps an 8 KiB cartridge while preserving writable RAM below ROML', () => {
    const memory = new C64Memory(createTestFirmware(), {
      cartridge: new StandardRomCartridge({
        mode: C64_CARTRIDGE_MODE.game8K,
        romLow: createRom(0x81),
      }),
    });

    expect(memory.read(0x8000)).toBe(0x81);
    expect(memory.read(0xa000)).toBe(0xba);
    memory.write(0x8000, 0x42);
    expect(memory.read(0x8000)).toBe(0x81);

    memory.write(0x0000, 0x07);
    memory.write(0x0001, 0x00);
    expect(memory.read(0x8000)).toBe(0x42);
  });

  it('leaves the expansion-port interrupt pins released', () => {
    const cartridge = new StandardRomCartridge({
      mode: C64_CARTRIDGE_MODE.game8K,
      romLow: createRom(0x81),
    });

    expect(cartridge.irqLineLow).toBe(false);
    expect(cartridge.nmiLineLow).toBe(false);
  });

  it('maps independent ROML and ROMH images for a 16 KiB cartridge', () => {
    const memory = new C64Memory(createTestFirmware(), {
      cartridge: new StandardRomCartridge({
        mode: C64_CARTRIDGE_MODE.game16K,
        romHigh: createRom(0xa1),
        romLow: createRom(0x81),
      }),
    });

    expect(memory.read(0x8000)).toBe(0x81);
    expect(memory.read(0xa000)).toBe(0xa1);
    expect(memory.read(0xe000)).toBe(0xe1);
  });

  it('models Ultimax open-bus holes and prevents disconnected writes from reaching RAM', () => {
    const memory = new C64Memory(createTestFirmware(), {
      cartridge: new StandardRomCartridge({
        mode: C64_CARTRIDGE_MODE.ultimax,
        romHigh: createRom(0xe8),
        romLow: createRom(0x88),
      }),
    });
    memory.ram[0x1000] = 0x11;
    memory.ram[0x8000] = 0x22;
    memory.ram[0xa000] = 0x33;

    expect(memory.read(0x0200)).toBe(0x00);
    expect(memory.read(0x1000)).toBe(0xff);
    expect(memory.read(0x8000)).toBe(0x88);
    expect(memory.read(0xa000)).toBe(0xff);
    expect(memory.read(0xe000)).toBe(0xe8);

    memory.write(0x1000, 0x44);
    memory.write(0x8000, 0x55);
    memory.write(0xa000, 0x66);
    expect(memory.ram[0x1000]).toBe(0x11);
    expect(memory.ram[0x8000]).toBe(0x22);
    expect(memory.ram[0xa000]).toBe(0x33);
  });

  it('treats unimplemented IO1 and IO2 selects as explicit high-impedance bus states', () => {
    const memory = new C64Memory(createTestFirmware());
    memory.ram[0xde00] = 0x12;
    memory.ram[0xdf00] = 0x34;

    expect(memory.read(0xde00)).toBe(0xff);
    expect(memory.read(0xdf00)).toBe(0xff);
    memory.write(0xde00, 0x56);
    memory.write(0xdf00, 0x78);
    expect(memory.ram[0xde00]).toBe(0x12);
    expect(memory.ram[0xdf00]).toBe(0x34);
  });

  it('validates exact physical ROM chip sizes', () => {
    expect(
      () =>
        new StandardRomCartridge({
          mode: C64_CARTRIDGE_MODE.game8K,
          romLow: new Uint8Array(1),
        }),
    ).toThrow(/ROML must contain 8192 bytes/);
  });
});
