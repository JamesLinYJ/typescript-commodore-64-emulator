// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - PRG 解析、RAM 注入与启动测试
//
//   文件:       PrgLoader.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { installPrg, parsePrg, PRG_START_MODE } from '../../src/media/PrgLoader';
import { createC64System } from '../helpers/createTestSystem';

const BASIC_TEXT_START = 0x0801;
const BASIC_KEYBOARD_BUFFER = {
  capacityAddress: 0x0289,
  countAddress: 0x00c6,
  start: 0x0277,
} as const;

function prepareBasicAutostart(memory: ReturnType<typeof createC64System>['memory']): void {
  memory.ram[0x002b] = BASIC_TEXT_START & 0xff;
  memory.ram[0x002c] = BASIC_TEXT_START >>> 8;
  memory.ram[BASIC_KEYBOARD_BUFFER.capacityAddress] = 10;
  memory.ram[BASIC_KEYBOARD_BUFFER.countAddress] = 0;
}

function readRamWord(
  memory: ReturnType<typeof createC64System>['memory'],
  address: number,
): number {
  return (memory.ram[address] ?? 0) | ((memory.ram[address + 1] ?? 0) << 8);
}

describe('PRG loading', () => {
  it('parses the little-endian load address and owns a payload copy', () => {
    const input = new Uint8Array([0x01, 0x08, 0xaa, 0xbb]);
    const image = parsePrg(input);
    input[2] = 0x00;

    expect(image.loadAddress).toBe(BASIC_TEXT_START);
    expect([...image.bytes]).toEqual([0xaa, 0xbb]);
  });

  it('rejects missing payloads and ranges that cross the 16-bit address space', () => {
    expect(() => parsePrg(new Uint8Array([0x01]))).toThrow(/two-byte load address/);
    expect(() => parsePrg(new Uint8Array([0x01, 0x08]))).toThrow(/payload byte/);
    expect(() => parsePrg(new Uint8Array([0xff, 0xff, 0xaa, 0xbb]))).toThrow(
      /exceeds the 64 KiB address space/,
    );
  });

  it('injects into physical RAM without touching memory-mapped I/O', () => {
    const { cpu, memory } = createC64System();
    const borderBefore = memory.vic.borderColor;

    const loaded = installPrg(parsePrg(new Uint8Array([0x20, 0xd0, 0x06])), memory, cpu);

    expect(loaded).toEqual({
      endAddress: 0xd021,
      loadAddress: 0xd020,
      size: 1,
      startMode: PRG_START_MODE.none,
    });
    expect(memory.ram[0xd020]).toBe(0x06);
    expect(memory.vic.borderColor).toBe(borderBefore);
  });

  it('rejects unsupported start modes instead of silently treating them as no-start', () => {
    const { cpu, memory } = createC64System();
    const program = parsePrg(new Uint8Array([0x00, 0x20, 0xaa]));
    memory.ram[0x2000] = 0x7e;

    expect(() => {
      Reflect.apply(installPrg, undefined, [
        program,
        memory,
        cpu,
        { startMode: 'compatibility-fallback' },
      ]);
    }).toThrow(/Unsupported PRG start mode/);
    expect(memory.ram[0x2000]).toBe(0x7e);
  });

  it('starts an explicitly selected machine-code entry without guessing from the load address', () => {
    const { cpu, memory } = createC64System();
    const loaded = installPrg(
      parsePrg(new Uint8Array([0x00, 0x20, 0xa9, 0x01, 0x60])),
      memory,
      cpu,
      { entryAddress: 0x2001, startMode: PRG_START_MODE.direct },
    );

    expect([...memory.copyRam(0x2000, 3)]).toEqual([0xa9, 0x01, 0x60]);
    expect(cpu.getRegisters().programCounter).toBe(0x2001);
    expect(loaded.startMode).toBe(PRG_START_MODE.direct);
  });

  it('mirrors BASIC LOAD pointers and queues RUN only after validating the ready machine', () => {
    const { cpu, memory } = createC64System();
    prepareBasicAutostart(memory);

    const loaded = installPrg(parsePrg(new Uint8Array([0x01, 0x08, 0x00, 0x00])), memory, cpu, {
      startMode: PRG_START_MODE.basicRun,
    });

    expect(loaded.endAddress).toBe(0x0803);
    for (const pointer of [0x002b, 0x00ac]) {
      expect(readRamWord(memory, pointer)).toBe(BASIC_TEXT_START);
    }
    for (const pointer of [0x002d, 0x002f, 0x0031, 0x00ae]) {
      expect(readRamWord(memory, pointer)).toBe(loaded.endAddress);
    }
    expect([...memory.copyRam(BASIC_KEYBOARD_BUFFER.start, 4)]).toEqual([0x52, 0x55, 0x4e, 0x0d]);
    expect(memory.ram[BASIC_KEYBOARD_BUFFER.countAddress]).toBe(4);
  });

  it('fails atomically when BASIC is not ready or the keyboard buffer is full', () => {
    const { cpu, memory } = createC64System();
    memory.ram[BASIC_TEXT_START] = 0x7e;
    const program = parsePrg(new Uint8Array([0x01, 0x08, 0xaa]));

    expect(() => installPrg(program, memory, cpu, { startMode: PRG_START_MODE.basicRun })).toThrow(
      /BASIC is not ready/,
    );
    expect(memory.ram[BASIC_TEXT_START]).toBe(0x7e);

    prepareBasicAutostart(memory);
    memory.ram[BASIC_KEYBOARD_BUFFER.countAddress] = 8;
    expect(() => installPrg(program, memory, cpu, { startMode: PRG_START_MODE.basicRun })).toThrow(
      /RUN requires 4/,
    );
    expect(memory.ram[BASIC_TEXT_START]).toBe(0x7e);
  });
});
