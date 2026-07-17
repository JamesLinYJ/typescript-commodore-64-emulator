// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - EasyFlash 卡带集成测试
//
//   文件:       EasyFlashCartridge.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { AMD_29F040B_FLASH_LAYOUT } from '../../src/core/memory/Amd29F040BFlash';
import { C64Memory } from '../../src/core/memory/C64Memory';
import { EasyFlashCartridge, EASY_FLASH_LAYOUT } from '../../src/core/memory/EasyFlashCartridge';
import { C64_CARTRIDGE_MODE } from '../../src/core/memory/C64Pla';
import { C64Machine } from '../../src/core/C64Machine';
import { Cpu6502 } from '../../src/core/cpu/Cpu6502';
import { createTestFirmware } from '../helpers/createTestSystem';

function createBankedFlash(base: number): Uint8Array {
  const bytes = new Uint8Array(AMD_29F040B_FLASH_LAYOUT.capacityBytes);
  for (let bank = 0; bank < EASY_FLASH_LAYOUT.bankCount; bank += 1) {
    bytes.fill(
      (base + bank) & 0xff,
      bank * EASY_FLASH_LAYOUT.bankSizeBytes,
      (bank + 1) * EASY_FLASH_LAYOUT.bankSizeBytes,
    );
  }
  return bytes;
}

function createCartridge(jumperInstalled = false): EasyFlashCartridge {
  return new EasyFlashCartridge({
    flashHigh: createBankedFlash(0x80),
    flashLow: createBankedFlash(0x00),
    jumperInstalled,
  });
}

function issueLowFlashProgram(memory: C64Memory, address: number, value: number): void {
  memory.write(0x8555, 0xaa);
  memory.write(0x82aa, 0x55);
  memory.write(0x8555, 0xa0);
  memory.write(address, value);
}

describe('EasyFlashCartridge', () => {
  it('selects all 64 banks and mirrors the two write-only IO1 registers', () => {
    const cartridge = createCartridge();

    expect(cartridge.cartridgeMode).toBe(C64_CARTRIDGE_MODE.ultimax);
    expect(cartridge.gameLineHigh).toBe(false);
    expect(cartridge.exromLineHigh).toBe(true);
    expect(cartridge.readIo1(0xde00)).toBeNull();

    cartridge.writeIo1(0xdefc, 63);
    expect(cartridge.selectedBank).toBe(63);
    expect(cartridge.readRomLow(0x8000)).toBe(0x3f);
    expect(cartridge.readRomHigh(0xe000)).toBe(0xbf);

    cartridge.writeIo1(0xdeff, 0x86);
    expect(cartridge.modeRegister).toBe(0x86);
    expect(cartridge.ledOn).toBe(true);
    expect(cartridge.cartridgeMode).toBe(C64_CARTRIDGE_MODE.game8K);
    expect(cartridge.gameLineHigh).toBe(true);
    expect(cartridge.exromLineHigh).toBe(false);
  });

  it('implements every jumper-off mode combination as physical GAME/EXROM levels', () => {
    const cartridge = createCartridge();
    const expected = [
      C64_CARTRIDGE_MODE.ultimax,
      C64_CARTRIDGE_MODE.ultimax,
      C64_CARTRIDGE_MODE.game16K,
      C64_CARTRIDGE_MODE.game16K,
      C64_CARTRIDGE_MODE.detached,
      C64_CARTRIDGE_MODE.ultimax,
      C64_CARTRIDGE_MODE.game8K,
      C64_CARTRIDGE_MODE.game16K,
    ] as const;

    for (let register = 0; register < expected.length; register += 1) {
      cartridge.writeIo1(0xde02, register);
      expect(cartridge.cartridgeMode, `mode register ${register}`).toBe(expected[register]);
    }
  });

  it('uses the installed jumper table without an implicit compatibility mode', () => {
    const cartridge = createCartridge(true);

    expect(cartridge.jumperInstalled).toBe(true);
    expect(cartridge.cartridgeMode).toBe(C64_CARTRIDGE_MODE.detached);
    cartridge.writeIo1(0xde02, 2);
    expect(cartridge.cartridgeMode).toBe(C64_CARTRIDGE_MODE.game8K);
  });

  it('retains IO2 SRAM and programmed flash across a cartridge reset', () => {
    const cartridge = createCartridge();
    const memory = new C64Memory(createTestFirmware(), { cartridge });
    const cpu = new Cpu6502(memory);
    const machine = new C64Machine(cpu, memory);

    memory.write(0xde00, 4);
    memory.write(0xde02, 0);
    memory.write(0xdf7a, 0x6c);
    issueLowFlashProgram(memory, 0x8123, 0x00);
    expect(cartridge.flashLow.peek(4 * EASY_FLASH_LAYOUT.bankSizeBytes + 0x123)).toBe(0x04);

    machine.advanceHardware(AMD_29F040B_FLASH_LAYOUT.byteProgramCycles);
    expect(memory.read(0x8123)).toBe(0x00);
    memory.resetHardware();

    expect(cartridge.selectedBank).toBe(0);
    expect(memory.read(0xdf7a)).toBe(0x6c);
    memory.write(0xde00, 4);
    expect(memory.read(0x8123)).toBe(0x00);
  });

  it('keeps normal 8K/16K writes in C64 RAM instead of spuriously programming flash', () => {
    const cartridge = createCartridge();
    const memory = new C64Memory(createTestFirmware(), { cartridge });
    const flashAddress = 0x0123;

    memory.write(0xde02, 0x06);
    const flashBefore = cartridge.flashLow.peek(flashAddress);
    memory.write(0x8123, 0x5a);

    expect(memory.ram[0x8123]).toBe(0x5a);
    expect(cartridge.flashLow.peek(flashAddress)).toBe(flashBefore);
  });
});
