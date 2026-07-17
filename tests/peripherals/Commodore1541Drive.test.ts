// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Commodore 1541 驱动器整机测试
//
//   文件:       Commodore1541Drive.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { D64_LAYOUT, d64SectorCountThroughTrack } from '../../src/media/D64DiskImage';
import { G64_LAYOUT } from '../../src/media/G64DiskImage';
import { Commodore1541Drive } from '../../src/peripherals/drive1541/Commodore1541Drive';
import { DRIVE_1541_MEMORY_LAYOUT } from '../../src/peripherals/drive1541/Drive1541Memory';
import { IecBus, IEC_LINE } from '../../src/peripherals/iec/IecBus';

function createDrive(): Commodore1541Drive {
  const rom = new Uint8Array(DRIVE_1541_MEMORY_LAYOUT.rom.imageSize);
  rom.fill(0xea); // NOP
  rom[0x3ffc] = 0x00;
  rom[0x3ffd] = 0xc0;
  return new Commodore1541Drive({ deviceNumber: 8, iecBus: new IecBus(), rom });
}

function createD64Bytes(): Uint8Array {
  return new Uint8Array(d64SectorCountThroughTrack(35) * D64_LAYOUT.sectorSize);
}

function createG64Bytes(): Uint8Array {
  const halfTrackCount = G64_LAYOUT.maximumHalfTrackCount;
  const bytes = new Uint8Array(G64_LAYOUT.headerSize + halfTrackCount * 8);
  bytes.set(Uint8Array.from(G64_LAYOUT.signature, (character) => character.charCodeAt(0)));
  bytes[G64_LAYOUT.versionOffset] = G64_LAYOUT.supportedVersion;
  bytes[G64_LAYOUT.trackCountOffset] = halfTrackCount;
  bytes[G64_LAYOUT.maximumTrackLengthOffset] = 16;
  return bytes;
}

describe('Commodore1541Drive', () => {
  it('boots its own 6502 from the DOS ROM and advances through the PAL host clock adapter', () => {
    const drive = createDrive();
    expect(drive.cpu.pc).toBe(0xc000);
    drive.clock.advanceHostCycles(100);
    expect(drive.clock.targetCycles).toBe(101);
    expect(drive.machine.elapsedCycles).toBeGreaterThanOrEqual(101);
    expect(drive.cpu.pc).toBeGreaterThan(0xc000);
  });

  it('mounts D64 media through the physical mechanism and preserves explicit eject semantics', () => {
    const drive = createDrive();
    const image = drive.mountD64(createD64Bytes(), { writeProtected: true });
    expect(drive.mechanism.mountedDisk).toBe(image);
    expect(drive.mechanism.writeProtected).toBe(true);
    expect(drive.ejectDisk()).toBe(image);
  });

  it('mounts G64 raw media and keeps format-specific eject operations explicit', () => {
    const drive = createDrive();
    const image = drive.mountG64(createG64Bytes());
    expect(drive.mechanism.mountedDisk).toBe(image);
    expect(() => drive.ejectD64()).toThrow(/not a D64/);
    expect(drive.mechanism.mountedDisk).toBe(image);
    expect(drive.ejectG64()).toBe(image);
  });

  it('resets electronics and CPU timing while retaining the physical disk and head position', () => {
    const drive = createDrive();
    const image = drive.mountD64(createD64Bytes());
    drive.mechanism.applyControlState({
      ledOn: false,
      motorOn: true,
      speedZone: 3,
      stepperPhase: 3,
    });
    expect(drive.mechanism.currentHalfTrack).toBe(37);
    drive.clock.advanceHostCycles(20);

    drive.reset();
    expect(drive.mechanism.mountedDisk).toBe(image);
    expect(drive.mechanism.currentHalfTrack).toBe(37);
    expect(drive.mechanism.motorOn).toBe(false);
    expect(drive.machine.elapsedCycles).toBe(0);
    expect(drive.cpu.pc).toBe(0xc000);
  });

  it('resets from the shared IEC RESET line on its asserted edge', () => {
    const drive = createDrive();
    const host = drive.iecVia.iecBus.attach('reset test host');
    drive.clock.advanceHostCycles(20);
    drive.memory.ram[0x20] = 0x5a;
    expect(drive.machine.elapsedCycles).toBeGreaterThan(0);

    host.setPulledLow(IEC_LINE.reset, true);

    expect(drive.cpu.pc).toBe(0xc000);
    expect(drive.machine.elapsedCycles).toBe(0);
    expect(drive.memory.ram[0x20]).toBe(0x5a);
  });

  it('disconnects both VIA observers and rejects repeated disposal', () => {
    const drive = createDrive();
    drive.dispose();
    expect(() => drive.dispose()).toThrow(/disconnected/);
    expect(() => drive.mountD64(createD64Bytes())).toThrow(/disconnected/);
  });
});
