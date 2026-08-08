// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 逐周期因果时序测试
//
//   文件:       Drive1541CycleCausality.test.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { Cpu6502 } from '../../src/core/cpu/Cpu6502';
import { MOS_6522_REGISTER } from '../../src/devices/Mos6522Registers';
import {
  Drive1541ClockSynchronizer,
  DRIVE_1541_CLOCK,
} from '../../src/peripherals/drive1541/Drive1541ClockSynchronizer';
import { Drive1541DiskVia } from '../../src/peripherals/drive1541/Drive1541DiskVia';
import {
  Drive1541IecVia,
  DRIVE_1541_IEC_PORT_B_BIT,
} from '../../src/peripherals/drive1541/Drive1541IecVia';
import { Drive1541Machine } from '../../src/peripherals/drive1541/Drive1541Machine';
import { Drive1541Mechanism } from '../../src/peripherals/drive1541/Drive1541Mechanism';
import {
  DRIVE_1541_MEMORY_LAYOUT,
  Drive1541Memory,
} from '../../src/peripherals/drive1541/Drive1541Memory';
import { IecBus, IEC_LINE } from '../../src/peripherals/iec/IecBus';

function createCycleDrive(program: readonly number[]): {
  readonly bus: IecBus;
  readonly hostPort: ReturnType<IecBus['attach']>;
  readonly iecVia: Drive1541IecVia;
  readonly machine: Drive1541Machine;
  readonly synchronizer: Drive1541ClockSynchronizer;
} {
  const bus = new IecBus();
  const hostPort = bus.attach('cycle-causality host');
  const mechanism = new Drive1541Mechanism();
  const iecVia = new Drive1541IecVia({ deviceNumber: 8, iecBus: bus });
  const diskVia = new Drive1541DiskVia({ deviceNumber: 8, mechanism });
  const rom = new Uint8Array(DRIVE_1541_MEMORY_LAYOUT.rom.imageSize);
  rom.set(program);
  rom[0x3ffc] = 0x00;
  rom[0x3ffd] = 0xc0;
  const memory = new Drive1541Memory(rom, { diskVia, iecVia });
  const machine = new Drive1541Machine(new Cpu6502(memory), memory, mechanism);
  // 1:1 时钟只用于把因果断言写成明确的第 N 周期。
  const synchronizer = new Drive1541ClockSynchronizer(machine, DRIVE_1541_CLOCK.processorClockHz);
  return { bus, hostPort, iecVia, machine, synchronizer };
}

describe('Drive1541ClockSynchronizer cycle causality', () => {
  it('samples a host IEC DATA transition only on the absolute-read bus cycle', () => {
    const { hostPort, machine, synchronizer } = createCycleDrive([0xad, 0x00, 0x18]);

    synchronizer.advanceHostCycles(3);
    expect(machine.elapsedCycles).toBe(3);
    hostPort.setPulledLow(IEC_LINE.data, true);
    synchronizer.advanceHostCycles(1);

    expect(machine.elapsedCycles).toBe(4);
    expect(machine.cpu.getRegisters().accumulator & DRIVE_1541_IEC_PORT_B_BIT.dataInput).toBe(
      DRIVE_1541_IEC_PORT_B_BIT.dataInput,
    );
  });

  it('does not expose a VIA write before the STA absolute write bus cycle', () => {
    // LDA #$08 (2) + NOP (2) + NOP (2) + STA $1800 (4) = 写访问恰在第 10 周期。
    const { bus, iecVia, machine, synchronizer } = createCycleDrive([
      0xa9, 0x08, 0xea, 0xea, 0x8d, 0x00, 0x18,
    ]);
    iecVia.write(MOS_6522_REGISTER.dataDirectionB, DRIVE_1541_IEC_PORT_B_BIT.clockOutput);
    expect(bus.state.clockHigh).toBe(true);

    synchronizer.advanceHostCycles(9);
    expect(machine.elapsedCycles).toBe(9);
    expect(bus.state.clockHigh).toBe(true);

    synchronizer.advanceHostCycles(1);
    expect(machine.elapsedCycles).toBe(10);
    expect(bus.state.clockHigh).toBe(false);
  });
});
