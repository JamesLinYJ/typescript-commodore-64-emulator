// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 CPU 与外设时钟测试
//
//   文件:       Drive1541Machine.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { Cpu6502 } from '../../src/core/cpu/Cpu6502';
import { D64DiskImage, D64_LAYOUT, d64SectorCountThroughTrack } from '../../src/media/D64DiskImage';
import { Drive1541DiskVia } from '../../src/peripherals/drive1541/Drive1541DiskVia';
import { Drive1541IecVia } from '../../src/peripherals/drive1541/Drive1541IecVia';
import { Drive1541Machine } from '../../src/peripherals/drive1541/Drive1541Machine';
import {
  DRIVE_1541_MECHANISM,
  Drive1541Mechanism,
} from '../../src/peripherals/drive1541/Drive1541Mechanism';
import {
  DRIVE_1541_MEMORY_LAYOUT,
  Drive1541Memory,
} from '../../src/peripherals/drive1541/Drive1541Memory';
import { IecBus } from '../../src/peripherals/iec/IecBus';

const OVERFLOW_FLAG = 1 << 6;

function createMachine(program: readonly number[] = [0xea]): {
  readonly machine: Drive1541Machine;
  readonly mechanism: Drive1541Mechanism;
} {
  const rom = new Uint8Array(DRIVE_1541_MEMORY_LAYOUT.rom.imageSize);
  rom.set(program);
  rom[0x3ffc] = 0x00;
  rom[0x3ffd] = 0xc0;
  const mechanism = new Drive1541Mechanism();
  const iecVia = new Drive1541IecVia({ deviceNumber: 8, iecBus: new IecBus() });
  const diskVia = new Drive1541DiskVia({ deviceNumber: 8, mechanism });
  const memory = new Drive1541Memory(rom, { diskVia, iecVia });
  const cpu = new Cpu6502(memory);
  return { machine: new Drive1541Machine(cpu, memory, mechanism), mechanism };
}

function createDisk(): D64DiskImage {
  const bytes = new Uint8Array(d64SectorCountThroughTrack(35) * D64_LAYOUT.sectorSize);
  const directoryOffset = d64SectorCountThroughTrack(17) * D64_LAYOUT.sectorSize;
  bytes[directoryOffset + D64_LAYOUT.directoryHeader.diskId1Offset] = 0x4a;
  bytes[directoryOffset + D64_LAYOUT.directoryHeader.diskId2Offset] = 0x53;
  return new D64DiskImage(bytes);
}

function finishDiskInsertion(mechanism: Drive1541Mechanism): void {
  mechanism.tick(DRIVE_1541_MECHANISM.diskChange.insertionCycles);
}

describe('Drive1541Machine', () => {
  it('advances hardware once per observed 6502 bus cycle', () => {
    const { machine } = createMachine([0xea]); // NOP
    expect(machine.cpu.pc).toBe(0xc000);
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.elapsedCycles).toBe(2);
    expect(machine.cpu.pc).toBe(0xc001);
  });

  it('batches adjacent cycles without crossing an unrequested bus-cycle boundary', () => {
    const program = [0xa9, 0x42, 0x8d, 0x00, 0x00, 0xea]; // LDA #$42; STA $0000; NOP
    const batched = createMachine(program).machine;
    const stepped = createMachine(program).machine;

    expect(batched.clockCycles(5)).toBe(5);
    for (let cycle = 0; cycle < 5; cycle += 1) expect(stepped.clockCycle()).toBe(1);

    expect(batched.elapsedCycles).toBe(5);
    expect(batched.cpu.isAtInstructionBoundary).toBe(false);
    expect(batched.cpu.getRegisters()).toEqual(stepped.cpu.getRegisters());
    expect(batched.memory.lastDataBusValue).toBe(stepped.memory.lastDataBusValue);
    expect(() => batched.clockCycles(-1)).toThrow(/non-negative safe integer/);
  });

  it('routes an asserted BYTE READY edge to the 6502 SO pin', () => {
    const { machine, mechanism } = createMachine();
    mechanism.mountDisk(createDisk());
    finishDiskInsertion(mechanism);
    mechanism.setSpeedZone(2);
    mechanism.setMotorOn(true);
    expect(machine.cpu.getRegisters().status & OVERFLOW_FLAG).toBe(0);

    machine.advanceHardware(172);
    expect(mechanism.byteReadyAsserted).toBe(true);
    expect(machine.cpu.getRegisters().status & OVERFLOW_FLAG).toBe(OVERFLOW_FLAG);
  });

  it('routes every completed write byte to SO even while the VIA BYTE READY level remains asserted', () => {
    const { machine, mechanism } = createMachine([0xb8]); // CLV
    mechanism.mountDisk(createDisk());
    finishDiskInsertion(mechanism);
    mechanism.setSpeedZone(0);
    mechanism.setWriteDataByte(0xff);
    mechanism.setReadMode(false);
    mechanism.setMotorOn(true);

    // Zone 0 每 32 个 1 MHz 周期完成一个字节。第一次边界同时置位 VIA 可见电平与 SO。
    machine.advanceHardware(32);
    expect(mechanism.byteReadyAsserted).toBe(true);
    expect(machine.cpu.getRegisters().status & OVERFLOW_FLAG).toBe(OVERFLOW_FLAG);

    // 1541 ROM 用 CLV 应答 SO，却不访问 VIA2 端口；因此 CA1 电平仍保持断言。
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.cpu.getRegisters().status & OVERFLOW_FLAG).toBe(0);
    expect(mechanism.byteReadyAsserted).toBe(true);

    // 下一个字节边界必须产生新的 SO 边沿，否则 ROM 的 BVC 写同步循环会永久等待。
    machine.advanceHardware(30);
    expect(mechanism.byteReadyAsserted).toBe(true);
    expect(machine.cpu.getRegisters().status & OVERFLOW_FLAG).toBe(OVERFLOW_FLAG);
  });

  it('keeps manually advanced peripheral cycles in the same monotonic clock domain', () => {
    const { machine } = createMachine([0xea]);
    machine.advanceHardware(10);
    expect(machine.elapsedCycles).toBe(10);
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.elapsedCycles).toBe(12);
    machine.resetTiming();
    expect(machine.elapsedCycles).toBe(0);
  });

  it('advances both VIAs and the disk mechanism during the CPU reset bus sequence', () => {
    const { machine } = createMachine();

    expect(machine.resetCpu()).toBe(7);
    expect(machine.elapsedCycles).toBe(7);
    expect(machine.cpu.pc).toBe(0xc000);
  });
});
