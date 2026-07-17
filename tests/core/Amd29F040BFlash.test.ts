// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - AMD AM29F040B Flash 行为测试
//
//   文件:       Amd29F040BFlash.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  Amd29F040BFlash,
  AMD_29F040B_FLASH_LAYOUT,
  AMD_29F040B_FLASH_STATE,
} from '../../src/core/memory/Amd29F040BFlash';

const TEST_PROGRAM_ADDRESS = 0x12345;

function createFlash(fill = 0xff): Amd29F040BFlash {
  return new Amd29F040BFlash(new Uint8Array(AMD_29F040B_FLASH_LAYOUT.capacityBytes).fill(fill));
}

function issueUnlockedCommand(flash: Amd29F040BFlash, command: number): void {
  flash.write(AMD_29F040B_FLASH_LAYOUT.unlockAddress1, 0xaa);
  flash.write(AMD_29F040B_FLASH_LAYOUT.unlockAddress2, 0x55);
  flash.write(AMD_29F040B_FLASH_LAYOUT.unlockAddress1, command);
}

function beginEraseCommand(flash: Amd29F040BFlash): void {
  issueUnlockedCommand(flash, 0x80);
  flash.write(AMD_29F040B_FLASH_LAYOUT.unlockAddress1, 0xaa);
  flash.write(AMD_29F040B_FLASH_LAYOUT.unlockAddress2, 0x55);
}

describe('Amd29F040BFlash', () => {
  it('reports AMD manufacturer/device IDs in autoselect mode and exits with read-reset', () => {
    const flash = createFlash(0x5a);

    issueUnlockedCommand(flash, 0x90);

    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.autoselect);
    expect(flash.read(0x0000)).toBe(AMD_29F040B_FLASH_LAYOUT.manufacturerId);
    expect(flash.read(0x0001)).toBe(AMD_29F040B_FLASH_LAYOUT.deviceId);
    expect(flash.read(0x0002)).toBe(0);
    expect(flash.read(0x0103)).toBe(0x5a);

    flash.write(0x0000, 0xf0);
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.read);
    expect(flash.read(0x0000)).toBe(0x5a);
  });

  it('programs one byte after the observable DQ7/DQ6 busy interval', () => {
    const flash = createFlash();

    issueUnlockedCommand(flash, 0xa0);
    flash.write(TEST_PROGRAM_ADDRESS, 0x5a);

    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.byteProgramBusy);
    expect(flash.peek(TEST_PROGRAM_ADDRESS)).toBe(0xff);
    const status1 = flash.read(TEST_PROGRAM_ADDRESS);
    const status2 = flash.read(TEST_PROGRAM_ADDRESS);
    expect(status1 & 0x80).toBe(0x80);
    expect((status1 ^ status2) & AMD_29F040B_FLASH_LAYOUT.statusToggleBit).toBe(
      AMD_29F040B_FLASH_LAYOUT.statusToggleBit,
    );

    flash.tick(AMD_29F040B_FLASH_LAYOUT.byteProgramCycles - 1);
    expect(flash.peek(TEST_PROGRAM_ADDRESS)).toBe(0xff);
    flash.tick(1);

    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.read);
    expect(flash.read(TEST_PROGRAM_ADDRESS)).toBe(0x5a);
    expect(flash.dirty).toBe(true);
  });

  it('rejects a zero-to-one program attempt through DQ5 until read-reset', () => {
    const flash = createFlash(0x00);

    issueUnlockedCommand(flash, 0xa0);
    flash.write(TEST_PROGRAM_ADDRESS, 0xff);

    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.byteProgramError);
    expect(flash.read(TEST_PROGRAM_ADDRESS) & 0x20).toBe(0x20);
    expect(flash.peek(TEST_PROGRAM_ADDRESS)).toBe(0x00);
    flash.tick(AMD_29F040B_FLASH_LAYOUT.byteProgramCycles);
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.byteProgramError);

    flash.write(TEST_PROGRAM_ADDRESS, 0xf0);
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.read);
  });

  it('collects sectors during the 50-cycle window and erases them sequentially', () => {
    const flash = createFlash(0x00);
    const sectorOneAddress = AMD_29F040B_FLASH_LAYOUT.sectorSizeBytes + 0x123;
    const sectorThreeAddress = AMD_29F040B_FLASH_LAYOUT.sectorSizeBytes * 3 + 0x456;

    beginEraseCommand(flash);
    flash.write(sectorOneAddress, 0x30);
    flash.write(sectorThreeAddress, 0x30);

    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.sectorEraseWindow);
    expect(flash.read(sectorOneAddress) & 0x08).toBe(0);
    flash.tick(AMD_29F040B_FLASH_LAYOUT.sectorEraseWindowCycles);
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.sectorEraseBusy);
    expect(flash.read(sectorOneAddress) & 0x08).toBe(0x08);

    flash.tick(AMD_29F040B_FLASH_LAYOUT.sectorEraseCycles);
    expect(flash.peek(sectorOneAddress)).toBe(0xff);
    expect(flash.peek(sectorThreeAddress)).toBe(0x00);
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.sectorEraseBusy);

    flash.write(sectorThreeAddress, 0xb0);
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.sectorEraseSuspend);
    flash.tick(AMD_29F040B_FLASH_LAYOUT.sectorEraseCycles);
    expect(flash.peek(sectorThreeAddress)).toBe(0x00);
    flash.write(sectorThreeAddress, 0x30);
    flash.tick(AMD_29F040B_FLASH_LAYOUT.sectorEraseCycles);

    expect(flash.peek(sectorThreeAddress)).toBe(0xff);
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.read);
  });

  it('completes chip erase only after its full timed operation and preserves data on reset', () => {
    const flash = createFlash(0x00);

    beginEraseCommand(flash);
    flash.write(AMD_29F040B_FLASH_LAYOUT.unlockAddress1, 0x10);
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.chipEraseBusy);

    flash.tick(AMD_29F040B_FLASH_LAYOUT.chipEraseCycles - 1);
    expect(flash.peek(0x70000)).toBe(0x00);
    flash.tick(1);
    expect(flash.peek(0x70000)).toBe(0xff);

    flash.reset();
    expect(flash.state).toBe(AMD_29F040B_FLASH_STATE.read);
    expect(flash.peek(0x70000)).toBe(0xff);
  });
});
