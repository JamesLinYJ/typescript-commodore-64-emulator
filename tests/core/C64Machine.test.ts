// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 整机时钟与总线仲裁测试
//
//   文件:       C64Machine.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { C64Machine } from '../../src/core/C64Machine';
import type {
  C64CartridgePort,
  C64CartridgeReadResult,
} from '../../src/core/memory/C64CartridgePort';
import { VIC_REGISTER, VIC_SCREEN_CONTROL_1_BIT } from '../../src/devices/vicRegisters';
import { createC64System } from '../helpers/createTestSystem';

function advanceVicTo(machine: C64Machine, rasterLine: number, cycle: number): void {
  const vic = machine.memory.vic;
  while (vic.currentRasterLine !== rasterLine || vic.currentRasterCycle !== cycle) {
    machine.advanceHardware(1);
  }
}

class InterruptTestCartridge implements C64CartridgePort {
  readonly exromLineHigh = true;
  readonly gameLineHigh = true;
  irqLineLow = false;
  nmiLineLow = false;

  readIo1(): C64CartridgeReadResult {
    return null;
  }

  readIo2(): C64CartridgeReadResult {
    return null;
  }

  readRomHigh(): C64CartridgeReadResult {
    return null;
  }

  readRomLow(): C64CartridgeReadResult {
    return null;
  }

  reset(): void {
    this.irqLineLow = false;
    this.nmiLineLow = false;
  }

  tick(): void {
    // 测试卡带没有时钟状态。
  }

  writeIo1(): void {
    // 此测试卡带只驱动中断引脚，不译码数据总线。
  }

  writeIo2(): void {
    // 此测试卡带只驱动中断引脚，不译码数据总线。
  }

  writeRomHigh(): void {
    // 此测试卡带只驱动中断引脚，不译码数据总线。
  }

  writeRomLow(): void {
    // 此测试卡带只驱动中断引脚，不译码数据总线。
  }
}

describe('C64Machine', () => {
  it('advances CPU instructions and all cycle-driven processor-port state together', () => {
    const { cpu, memory } = createC64System();
    memory.ram[0x0200] = 0xea;
    const machine = new C64Machine(cpu, memory);

    memory.write(0x0000, 0xc0);
    memory.write(0x0001, 0xc0);
    memory.write(0x0000, 0x00);
    expect(memory.read(0x0001) & 0xc0).toBe(0xc0);

    expect(machine.executeInstruction()).toBe(2);
    expect(machine.elapsedCycles).toBe(2);

    machine.advanceHardware(349_998);
    expect(machine.elapsedCycles).toBe(350_000);
    expect(memory.read(0x0001) & 0xc0).toBe(0x00);
  });

  it('resets timing without mutating CPU or memory state', () => {
    const { cpu, memory } = createC64System();
    const machine = new C64Machine(cpu, memory);
    machine.advanceHardware(123);

    machine.resetTiming();

    expect(machine.elapsedCycles).toBe(0);
  });

  it('stalls a CPU read until VIC-II releases BA on a bad line', () => {
    const { cpu, memory } = createC64System();
    memory.ram[0x0200] = 0xea;
    memory.vic.write(
      VIC_REGISTER.screenControl1,
      VIC_SCREEN_CONTROL_1_BIT.displayEnable | VIC_SCREEN_CONTROL_1_BIT.rowSelect,
    );
    const machine = new C64Machine(cpu, memory);
    advanceVicTo(machine, 0x30, 12);

    expect(memory.vic.badLine).toBe(true);
    expect(memory.vic.baLow).toBe(true);
    expect(machine.executeInstruction()).toBe(44);
    expect(memory.vic.currentRasterCycle).toBe(56);
  });

  it('allows an in-progress CPU write to finish while VIC-II BA is low', () => {
    const { cpu, memory } = createC64System();
    memory.ram.set([0x85, 0x10], 0x0200); // STA $10
    memory.vic.write(
      VIC_REGISTER.screenControl1,
      VIC_SCREEN_CONTROL_1_BIT.displayEnable | VIC_SCREEN_CONTROL_1_BIT.rowSelect,
    );
    const machine = new C64Machine(cpu, memory);
    advanceVicTo(machine, 0x30, 9);

    expect(machine.executeInstruction()).toBe(3);
    expect(memory.vic.currentRasterCycle).toBe(12);
    expect(memory.vic.baLow).toBe(true);
    expect(memory.ram[0x0010]).toBe(0x00);
  });

  it('samples BA on the attempted read cycle before allowing consecutive interrupt writes', () => {
    const { cpu, firmware, memory } = createC64System();
    memory.ram[0x0200] = 0x00; // BRK：一次操作码读、一次伪读、三次连续压栈写和两次向量读。
    firmware.kernal[0x1ffe] = 0x00;
    firmware.kernal[0x1fff] = 0x03;
    memory.vic.write(
      VIC_REGISTER.screenControl1,
      VIC_SCREEN_CONTROL_1_BIT.displayEnable | VIC_SCREEN_CONTROL_1_BIT.rowSelect,
    );
    const machine = new C64Machine(cpu, memory);
    advanceVicTo(machine, 0x30, 10);

    expect(machine.executeInstruction()).toBe(50);
    expect(memory.vic.currentRasterCycle).toBe(60);
    expect(cpu.getRegisters().programCounter).toBe(0x0300);
  });

  it('services RESTORE through the edge-latched board NMI line without direct CPU calls', () => {
    const { cpu, firmware, memory } = createC64System();
    memory.ram.fill(0xea, 0x0200, 0x0210);
    memory.ram[0x0300] = 0x40; // RTI
    firmware.kernal[0x1ffa] = 0x00;
    firmware.kernal[0x1ffb] = 0x03;
    const machine = new C64Machine(cpu, memory);

    memory.restoreKey.setRestoreKeyPressed(true);
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0300);

    expect(machine.executeInstruction()).toBe(6);
    expect(cpu.getRegisters().programCounter).toBe(0x0201);

    machine.advanceHardware(30);
    expect(machine.executeInstruction()).toBe(2);
    expect(cpu.getRegisters().programCounter).toBe(0x0202);

    memory.restoreKey.setRestoreKeyPressed(false);
    machine.advanceHardware(1);
    memory.restoreKey.setRestoreKeyPressed(true);
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0300);
  });

  it('routes the expansion-port IRQ and NMI pins through the normal CPU boundary timing', () => {
    const cartridge = new InterruptTestCartridge();
    const { cpu, firmware, memory } = createC64System();
    memory.insertCartridge(cartridge);
    memory.ram.set([0x58, 0xea, 0xea, 0xea], 0x0200); // CLI; NOP; NOP; NOP
    memory.ram[0x0300] = 0x40; // NMI handler: RTI
    memory.ram[0x0400] = 0x40; // IRQ handler: RTI
    firmware.kernal[0x1ffa] = 0x00;
    firmware.kernal[0x1ffb] = 0x03;
    firmware.kernal[0x1ffe] = 0x00;
    firmware.kernal[0x1fff] = 0x04;
    const machine = new C64Machine(cpu, memory);

    expect(machine.executeInstruction()).toBe(2);
    cartridge.irqLineLow = true;
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0400);

    cartridge.irqLineLow = false;
    expect(machine.executeInstruction()).toBe(6);
    cartridge.nmiLineLow = true;
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0300);
  });
});
