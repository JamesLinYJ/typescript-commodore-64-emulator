// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 内存与设备总线测试
//
//   文件:       C64Memory.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { C64Memory } from '../../src/core/memory/C64Memory';
import { CIA_REGISTER } from '../../src/devices/ciaRegisters';
import { MOS_6526_MODEL } from '../../src/devices/Mos6526Model';
import { SID_MODEL } from '../../src/devices/SidModel';
import { SID_REGISTER } from '../../src/devices/sidRegisters';
import { VIC_INTERRUPT_BIT, VIC_REGISTER } from '../../src/devices/vicRegisters';
import { C64_CONTROL_PORT_DIGITAL_LINE } from '../../src/peripherals/control/C64ControlPorts';
import { IecBus, IEC_LINE } from '../../src/peripherals/iec/IecBus';
import { createTestFirmware } from '../helpers/createTestSystem';

describe('C64Memory', () => {
  it('routes the selected control-port paddle resistance into the SID POT registers', () => {
    const memory = new C64Memory(createTestFirmware());
    const paddles = memory.controlPorts.port1.attachDevice('test paddles');
    paddles.setSignals({
      groundedDigitalLines: 0,
      paddleXResistanceOhms: 235_000,
      paddleYResistanceOhms: 117_500,
    });
    memory.cia1.write(CIA_REGISTER.dataDirectionA, 0xc0);
    memory.cia1.write(CIA_REGISTER.portA, 0x40);

    expect(memory.sid.read(SID_REGISTER.paddleX)).toBe(128);
    expect(memory.sid.read(SID_REGISTER.paddleY)).toBe(64);

    memory.resetHardware();
    expect(memory.sid.read(SID_REGISTER.paddleX)).toBe(128);
    expect(memory.sid.read(SID_REGISTER.paddleY)).toBe(64);
  });

  it('routes control-port 1 FIRE onto the VIC-II light-pen input', () => {
    const memory = new C64Memory(createTestFirmware());
    const controller = memory.controlPorts.port1.attachDevice('light pen');
    controller.setSignals({
      groundedDigitalLines: C64_CONTROL_PORT_DIGITAL_LINE.fire,
      paddleXResistanceOhms: null,
      paddleYResistanceOhms: null,
    });

    memory.vic.tickCycle(memory);

    expect(memory.vic.read(VIC_REGISTER.lightPenX)).toBe(0xcc);
    expect(memory.vic.read(VIC_REGISTER.interruptStatus) & VIC_INTERRUPT_BIT.lightPen).toBe(
      VIC_INTERRUPT_BIT.lightPen,
    );
  });

  it('maps VIC-II local addresses through the CIA2 bank and character ROM windows', () => {
    const firmware = createTestFirmware();
    firmware.character[0] = 0xa5;
    const memory = new C64Memory(firmware);

    memory.ram[0x0fff] = 0x11;
    memory.ram[0x1000] = 0x22;
    expect(memory.readVicByte(0x0fff)).toBe(0x11);
    expect(memory.readVicByte(0x1000)).toBe(0xa5);

    memory.cia2.write(CIA_REGISTER.dataDirectionA, 0x03);
    memory.cia2.write(CIA_REGISTER.portA, 0x00);
    memory.ram[0xd000] = 0x33;
    expect(memory.cia2.vicBankAddress).toBe(0xc000);
    expect(memory.readVicByte(0x1000)).toBe(0x33);

    memory.cia2.write(CIA_REGISTER.portA, 0x01);
    expect(memory.cia2.vicBankAddress).toBe(0x8000);
    expect(memory.readVicByte(0x1000)).toBe(0xa5);
  });

  it('exposes power-up processor-port values while keeping the KERNAL mapped', () => {
    const memory = new C64Memory(createTestFirmware());

    expect(memory.read(0x0000)).toBe(0x00);
    expect(memory.read(0x0001)).toBe(0x17);
    expect(memory.read(0xe000)).toBe(0xe1);
  });

  it('offers non-invasive write observation for debuggers and reference-test ports', () => {
    const memory = new C64Memory(createTestFirmware());
    const writes: { readonly address: number; readonly value: number }[] = [];
    const stopObserving = memory.observeWrites((event) => writes.push(event));

    memory.write(0xd7ff, 0xff);
    stopObserving();
    memory.write(0xd7ff, 0x00);

    expect(writes).toEqual([{ address: 0xd7ff, value: 0xff }]);
  });

  it('reports individual CPU bus cycles without counting word helpers twice', () => {
    const memory = new C64Memory(createTestFirmware());
    let startedCycles = 0;
    let completedCycles = 0;
    memory.setCpuBusCycleObserver({
      completeCpuBusCycle: () => {
        completedCycles += 1;
      },
      startCpuBusCycle: () => {
        startedCycles += 1;
      },
    });

    memory.readWord(0x0200);
    memory.writeWord(0x0200, 0x1234);
    memory.readStack(0xff);
    memory.writeStack(0xff, 0xaa);
    memory.setCpuBusCycleObserver(undefined);
    memory.read(0x0200);

    expect(startedCycles).toBe(6);
    expect(completedCycles).toBe(6);
  });

  it('latches CPU read and write data for VIC-II bus observation', () => {
    const memory = new C64Memory(createTestFirmware());
    const valuesSeenAtCycleStart: number[] = [];
    memory.setCpuBusCycleObserver({
      completeCpuBusCycle: () => undefined,
      startCpuBusCycle: () => valuesSeenAtCycleStart.push(memory.cpuDataBusValue),
    });

    expect(memory.cpuDataBusValue).toBe(0xff);
    memory.write(0x0200, 0xab);
    expect(valuesSeenAtCycleStart).toEqual([0xab]);
    expect(memory.cpuDataBusValue).toBe(0xab);

    memory.setCpuBusCycleObserver(undefined);
    memory.ram[0x0200] = 0x34;
    expect(memory.read(0x0200)).toBe(0x34);
    expect(memory.cpuDataBusValue).toBe(0x34);

    memory.resetHardware();
    expect(memory.cpuDataBusValue).toBe(0xff);
  });

  it('banks BASIC and KERNAL ROM over writable RAM', () => {
    const memory = new C64Memory(createTestFirmware());

    memory.write(0x0000, 0x07);
    memory.write(0x0001, 0x37);
    expect(memory.read(0xa000)).toBe(0xba);
    expect(memory.read(0xe000)).toBe(0xe1);

    memory.write(0xa000, 0x42);
    expect(memory.read(0xa000)).toBe(0xba);

    memory.write(0x0001, 0x00);
    expect(memory.read(0xa000)).toBe(0x42);
  });

  it('switches the D000 page between character ROM and I/O', () => {
    const memory = new C64Memory(createTestFirmware());

    memory.write(0x0000, 0x07);
    memory.write(0x0001, 0x03);
    expect(memory.read(0xd000)).toBe(0xcc);

    memory.write(0x0001, 0x07);
    memory.write(0xd020, 0x0e);
    memory.write(0xd800, 0x2f);
    expect(memory.read(0xd020)).toBe(0xfe);
    // 颜色 RAM 只有四位；未存储的高四位来自 VIC-II 最近一次 φ1 总线取数。
    expect(memory.read(0xd800)).toBe(0xff);
  });

  it('derives banking from the 6510 DDR and external pin levels', () => {
    const memory = new C64Memory(createTestFirmware());

    memory.write(0x0000, 0x00);
    memory.write(0x0001, 0x00);
    expect(memory.read(0x0001) & 0x07).toBe(0x07);
    expect(memory.read(0xa000)).toBe(0xba);

    memory.processorPort.setInputPins(0x07, 0x00);
    memory.write(0x0000, 0x00);
    expect(memory.read(0xa000)).toBe(memory.ram[0xa000]);
  });

  it('rejects firmware images with an invalid size', () => {
    const firmware = createTestFirmware();
    const invalidFirmware = { ...firmware, basic: new Uint8Array(10) };

    expect(() => new C64Memory(invalidFirmware)).toThrow(/BASIC ROM must contain 8192 bytes/);
  });

  it('configures CIA1 and CIA2 models independently', () => {
    const memory = new C64Memory(createTestFirmware(), {
      ciaModels: {
        cia1: MOS_6526_MODEL.revised,
        cia2: MOS_6526_MODEL.original,
      },
    });

    expect(memory.cia1.model).toBe(MOS_6526_MODEL.revised);
    expect(memory.cia2.model).toBe(MOS_6526_MODEL.original);
  });

  it('passes the selected SID model through the machine configuration', () => {
    const memory = new C64Memory(createTestFirmware(), { sidModel: SID_MODEL.mos8580 });

    expect(memory.sid.model).toBe(SID_MODEL.mos8580);
  });

  it('publishes a complete IEC RESET pulse during a C64 hardware reset', () => {
    const bus = new IecBus();
    const memory = new C64Memory(createTestFirmware(), { iecBus: bus });
    const observedLevels: boolean[] = [];
    bus.observe((transition) => {
      if (transition.changedLines.includes(IEC_LINE.reset)) {
        observedLevels.push(transition.state.resetHigh);
      }
    });

    memory.resetHardware();

    expect(observedLevels).toEqual([false, true]);
    expect(bus.state.resetHigh).toBe(true);
  });
});
