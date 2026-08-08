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
  private elapsedCycles = 0;
  private irqAssertionCycle: number | undefined;
  private nmiAssertionCycle: number | undefined;

  assertIrqAfter(cycles: number): void {
    this.irqAssertionCycle = this.elapsedCycles + cycles;
  }

  assertNmiAfter(cycles: number): void {
    this.nmiAssertionCycle = this.elapsedCycles + cycles;
  }

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
    this.elapsedCycles = 0;
    this.irqAssertionCycle = undefined;
    this.nmiAssertionCycle = undefined;
    this.irqLineLow = false;
    this.nmiLineLow = false;
  }

  tick(cycles: number): void {
    this.elapsedCycles += cycles;
    if (this.irqAssertionCycle !== undefined && this.elapsedCycles >= this.irqAssertionCycle) {
      this.irqLineLow = true;
    }
    if (this.nmiAssertionCycle !== undefined && this.elapsedCycles >= this.nmiAssertionCycle) {
      this.nmiLineLow = true;
    }
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

  it('advances the complete CPU reset bus sequence through every clocked device', () => {
    const { cpu, memory } = createC64System();
    const peripheral = {
      cycles: 0,
      advanceHostCycles(cycles: number): void {
        this.cycles += cycles;
      },
      resetClock(): void {
        this.cycles = 0;
      },
    };
    const machine = new C64Machine(cpu, memory, [peripheral]);

    expect(machine.resetCpu()).toBe(7);
    expect(machine.elapsedCycles).toBe(7);
    expect(peripheral.cycles).toBe(7);
    expect(memory.vic.currentRasterCycle).toBe(7);
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

  it('drives the current CPU read byte before dynamic bad-line C-accesses sample the bus', () => {
    const { cpu, memory } = createC64System();
    const opcodeAddress = 0x0200;
    memory.ram[opcodeAddress] = 0xea; // NOP；动态坏线前三列应看到低四位 $A。
    memory.write(0x0300, 0xab); // 制造与当前读不同的上一总线值，暴露相位倒置。
    memory.vic.write(
      VIC_REGISTER.screenControl1,
      VIC_SCREEN_CONTROL_1_BIT.displayEnable | VIC_SCREEN_CONTROL_1_BIT.rowSelect | 0x01,
    );
    const machine = new C64Machine(cpu, memory);

    // $30 行先锁存 DEN；$38 行的 YSCROLL 从 1 改为 0 后，周期 21 才动态启动坏线。
    advanceVicTo(machine, 0x38, 20);
    memory.vic.write(
      VIC_REGISTER.screenControl1,
      VIC_SCREEN_CONTROL_1_BIT.displayEnable | VIC_SCREEN_CONTROL_1_BIT.rowSelect,
    );

    machine.executeInstruction();

    const fetchState = memory.vic.captureRasterLineState().fetchState;
    expect([...fetchState.screenMatrix.slice(6, 9)]).toEqual([0xff, 0xff, 0xff]);
    expect([...fetchState.colorMatrix.slice(6, 9)]).toEqual([0x0a, 0x0a, 0x0a]);
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

  it('allows NMI recognized through BRK T4 to take over the vector while preserving B', () => {
    const cartridge = new InterruptTestCartridge();
    const { cpu, firmware, memory } = createC64System();
    memory.insertCartridge(cartridge);
    memory.ram[0x0200] = 0x00; // BRK
    firmware.kernal[0x1ffa] = 0x00;
    firmware.kernal[0x1ffb] = 0x04;
    firmware.kernal[0x1ffe] = 0x00;
    firmware.kernal[0x1fff] = 0x03;
    const machine = new C64Machine(cpu, memory);

    // 第四个总线周期是 PCL 压栈；此时出现的 NMI 在 T5 向量选择前已经完成两级识别。
    cartridge.assertNmiAfter(4);

    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0400);
    expect((memory.ram[0x01fb] ?? 0) & 0x10).toBe(0x10);
  });

  it('allows NMI recognized through IRQ T4 to take over the vector while keeping B clear', () => {
    const cartridge = new InterruptTestCartridge();
    const { cpu, firmware, memory } = createC64System();
    memory.insertCartridge(cartridge);
    memory.ram.set([0x58, 0xea, 0xea], 0x0200); // CLI; IRQ 识别延迟槽；NOP
    firmware.kernal[0x1ffa] = 0x00;
    firmware.kernal[0x1ffb] = 0x04;
    firmware.kernal[0x1ffe] = 0x00;
    firmware.kernal[0x1fff] = 0x03;
    const machine = new C64Machine(cpu, memory);

    cartridge.irqLineLow = true;
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.executeInstruction()).toBe(2);
    cartridge.assertNmiAfter(4);

    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0400);
    expect((memory.ram[0x01fb] ?? 0) & 0x10).toBe(0x00);
  });

  it('defers an NMI first recognized during IRQ T5 until after one handler instruction', () => {
    const cartridge = new InterruptTestCartridge();
    const { cpu, firmware, memory } = createC64System();
    memory.insertCartridge(cartridge);
    memory.ram.set([0x58, 0xea, 0xea], 0x0200); // CLI；IRQ 识别延迟槽；NOP。
    memory.ram[0x0300] = 0x48; // IRQ handler: PHA
    firmware.kernal[0x1ffa] = 0x00;
    firmware.kernal[0x1ffb] = 0x04;
    firmware.kernal[0x1ffe] = 0x00;
    firmware.kernal[0x1fff] = 0x03;
    const machine = new C64Machine(cpu, memory);

    cartridge.irqLineLow = true;
    expect(machine.executeInstruction()).toBe(2);
    expect(machine.executeInstruction()).toBe(2);
    // IRQ 压 P 的 T5 才捕获 NMI；它已经错过本次向量选择。
    cartridge.assertNmiAfter(5);

    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0300);
    expect(machine.executeInstruction()).toBe(3);
    expect(cpu.getRegisters().programCounter).toBe(0x0301);
    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0400);
  });

  it('defers an NMI first recognized during BRK T5 until after one handler instruction', () => {
    const cartridge = new InterruptTestCartridge();
    const { cpu, firmware, memory } = createC64System();
    memory.insertCartridge(cartridge);
    memory.ram[0x0200] = 0x00; // BRK
    memory.ram[0x0300] = 0xea; // IRQ/BRK handler: NOP
    firmware.kernal[0x1ffa] = 0x00;
    firmware.kernal[0x1ffb] = 0x04;
    firmware.kernal[0x1ffe] = 0x00;
    firmware.kernal[0x1fff] = 0x03;
    const machine = new C64Machine(cpu, memory);

    // 第五个总线周期才出现的边沿错过本次向量选择，不能产生混合或提前向量。
    cartridge.assertNmiAfter(5);

    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0300);
    expect(machine.executeInstruction()).toBe(2);
    expect(cpu.getRegisters().programCounter).toBe(0x0301);
    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0400);
  });

  it('does not reinterpret the I flag set by BRK as a sampled pre-BRK IRQ', () => {
    const cartridge = new InterruptTestCartridge();
    const { cpu, firmware, memory } = createC64System();
    memory.insertCartridge(cartridge);
    memory.ram.set([0x58, 0xea, 0x00], 0x0200); // CLI; NOP; BRK
    memory.ram[0x0300] = 0xea; // BRK handler: NOP
    firmware.kernal[0x1ffe] = 0x00;
    firmware.kernal[0x1fff] = 0x03;
    const machine = new C64Machine(cpu, memory);

    expect(machine.executeInstruction()).toBe(2);
    expect(machine.executeInstruction()).toBe(2);
    cartridge.assertIrqAfter(4);
    expect(machine.executeInstruction()).toBe(7);
    expect(cpu.getRegisters().programCounter).toBe(0x0300);

    expect(machine.executeInstruction()).toBe(2);
    expect(cpu.getRegisters().programCounter).toBe(0x0301);
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
