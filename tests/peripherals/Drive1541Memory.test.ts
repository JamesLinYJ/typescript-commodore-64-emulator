// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 内存地址译码测试
//
//   文件:       Drive1541Memory.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { MOS_6522_REGISTER } from '../../src/devices/Mos6522Registers';
import { Drive1541DiskVia } from '../../src/peripherals/drive1541/Drive1541DiskVia';
import { Drive1541IecVia } from '../../src/peripherals/drive1541/Drive1541IecVia';
import { Drive1541Mechanism } from '../../src/peripherals/drive1541/Drive1541Mechanism';
import {
  DRIVE_1541_MEMORY_LAYOUT,
  Drive1541Memory,
} from '../../src/peripherals/drive1541/Drive1541Memory';
import { IecBus } from '../../src/peripherals/iec/IecBus';

function createMemory(): {
  readonly diskVia: Drive1541DiskVia;
  readonly iecVia: Drive1541IecVia;
  readonly memory: Drive1541Memory;
  readonly rom: Uint8Array;
} {
  const rom = Uint8Array.from(
    { length: DRIVE_1541_MEMORY_LAYOUT.rom.imageSize },
    (_unused, index) => index,
  );
  const mechanism = new Drive1541Mechanism();
  const iecVia = new Drive1541IecVia({ deviceNumber: 8, iecBus: new IecBus() });
  const diskVia = new Drive1541DiskVia({ deviceNumber: 8, mechanism });
  const memory = new Drive1541Memory(rom, { diskVia, iecVia });
  return { diskVia, iecVia, memory, rom };
}

describe('Drive1541Memory', () => {
  it('mirrors 2 KiB RAM only in the four ranges selected by the address decoder', () => {
    const { memory } = createMemory();
    memory.write(0x0123, 0xa5);
    expect(memory.read(0x2123)).toBe(0xa5);
    expect(memory.read(0x4123)).toBe(0xa5);
    expect(memory.read(0x6123)).toBe(0xa5);

    memory.write(0x0923, 0x5a);
    expect(memory.read(0x0923)).toBe(0x5a);
    expect(memory.read(0x0123)).toBe(0xa5);
  });

  it('maps both VIAs into 1 KiB windows and mirrors those windows every $2000', () => {
    const { memory } = createMemory();
    memory.write(0x1800 + MOS_6522_REGISTER.dataDirectionB, 0x5a);
    memory.write(0x1c00 + MOS_6522_REGISTER.dataDirectionA, 0xa5);

    expect(memory.read(0x3800 + MOS_6522_REGISTER.dataDirectionB)).toBe(0x5a);
    expect(memory.read(0x5c00 + MOS_6522_REGISTER.dataDirectionA)).toBe(0xa5);
    expect(memory.read(0x7800 + MOS_6522_REGISTER.dataDirectionB)).toBe(0x5a);
    expect(memory.read(0x7c00 + MOS_6522_REGISTER.dataDirectionA)).toBe(0xa5);
  });

  it('mirrors the 16 KiB DOS ROM across $8000-$FFFF and ignores ROM writes', () => {
    const { memory, rom } = createMemory();
    expect(memory.read(0x8000)).toBe(rom[0]);
    expect(memory.read(0xbfff)).toBe(rom[0x3fff]);
    expect(memory.read(0xc000)).toBe(rom[0]);
    expect(memory.read(0xffff)).toBe(rom[0x3fff]);

    memory.write(0xc000, 0xff);
    expect(memory.read(0xc000)).toBe(rom[0]);
  });

  it('returns the last driven byte on undecoded open-bus ranges', () => {
    const { memory } = createMemory();
    memory.write(0x0800, 0x3c);
    expect(memory.lastDataBusValue).toBe(0x3c);
    expect(memory.read(0x17ff)).toBe(0x3c);

    memory.write(0x0000, 0x81);
    expect(memory.read(0x0000)).toBe(0x81);
    expect(memory.read(0x2800)).toBe(0x81);
  });

  it('observes one hardware cycle for each byte access, including stack and word operations', () => {
    const { memory } = createMemory();
    const events: string[] = [];
    memory.setCpuBusCycleObserver({
      completeCpuBusCycle: () => events.push('complete'),
      startCpuBusCycle: (kind, address) => events.push(`${kind}:${address.toString(16)}`),
    });

    memory.writeStack(0xfe, 0x55);
    expect(memory.readStack(0xfe)).toBe(0x55);
    memory.readWord(0x0000);
    expect(events).toEqual([
      'write:1fe',
      'complete',
      'read:1fe',
      'complete',
      'read:0',
      'complete',
      'read:1',
      'complete',
    ]);
  });

  it('rejects non-standard ROM lengths rather than guessing their address placement', () => {
    const { diskVia, iecVia } = createMemory();
    expect(() => new Drive1541Memory(new Uint8Array(0x2000), { diskVia, iecVia })).toThrow(
      /must contain 16384 bytes/,
    );
  });
});
