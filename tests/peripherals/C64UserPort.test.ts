// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 User Port 测试
//
//   文件:       C64UserPort.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  CIA_INTERRUPT_BIT,
  CIA_REGISTER,
  CIA_TIMER_CONTROL_BIT,
} from '../../src/devices/ciaRegisters';
import { C64Memory, type C64Firmware } from '../../src/core/memory/C64Memory';
import {
  C64UserPort,
  type C64UserPortDeviceSignals,
} from '../../src/peripherals/userport/C64UserPort';

const RELEASED_DEVICE_SIGNALS: C64UserPortDeviceSignals = {
  cia1SerialClockHigh: true,
  cia1SerialDataHigh: true,
  cia2FlagHigh: true,
  cia2SerialClockHigh: true,
  cia2SerialDataHigh: true,
  portA2High: true,
  portB: 0xff,
  resetPulledLow: false,
};

function createFirmware(): C64Firmware {
  return {
    basic: new Uint8Array(0x2000),
    character: new Uint8Array(0x1000),
    kernal: new Uint8Array(0x2000),
  };
}

function deviceSignals(
  overrides: Partial<C64UserPortDeviceSignals> = {},
): C64UserPortDeviceSignals {
  return { ...RELEASED_DEVICE_SIGNALS, ...overrides };
}

function clockCia2SerialByte(
  connection: ReturnType<C64UserPort['attachDevice']>,
  value: number,
): void {
  for (let bit = 7; bit >= 0; bit -= 1) {
    const dataHigh = (value & (1 << bit)) !== 0;
    connection.setSignals(
      deviceSignals({ cia2SerialClockHigh: false, cia2SerialDataHigh: dataHigh }),
    );
    connection.setSignals(
      deviceSignals({ cia2SerialClockHigh: true, cia2SerialDataHigh: dataHigh }),
    );
  }
}

function clockCia1SerialByte(
  connection: ReturnType<C64UserPort['attachDevice']>,
  value: number,
): void {
  for (let bit = 7; bit >= 0; bit -= 1) {
    const dataHigh = (value & (1 << bit)) !== 0;
    connection.setSignals(
      deviceSignals({ cia1SerialClockHigh: false, cia1SerialDataHigh: dataHigh }),
    );
    connection.setSignals(
      deviceSignals({ cia1SerialClockHigh: true, cia1SerialDataHigh: dataHigh }),
    );
  }
}

describe('C64UserPort', () => {
  it('owns one physical connector and releases all device-driven inputs on disconnect', () => {
    const userPort = new C64UserPort();
    const connection = userPort.attachDevice('parallel test device');
    connection.setSignals(deviceSignals({ cia2FlagHigh: false, portB: 0x55 }));

    expect(userPort.deviceSignals.portB).toBe(0x55);
    expect(() => userPort.attachDevice('second device')).toThrow(/already has an attached device/);
    connection.disconnect();

    expect(userPort.deviceAttached).toBe(false);
    expect(userPort.deviceSignals).toEqual(RELEASED_DEVICE_SIGNALS);
    expect(() => connection.setSignals(RELEASED_DEVICE_SIGNALS)).toThrow(/no longer attached/);
  });

  it('routes CIA2 PB0..PB7 and PA2 in both input and output directions', () => {
    const memory = new C64Memory(createFirmware());
    const connection = memory.userPort.attachDevice('parallel test device');
    connection.setSignals(deviceSignals({ portA2High: false, portB: 0xa5 }));

    expect(memory.cia2.read(CIA_REGISTER.portB)).toBe(0xa5);
    expect(memory.cia2.read(CIA_REGISTER.portA) & 0x04).toBe(0x00);

    memory.cia2.write(CIA_REGISTER.portB, 0xa5);
    memory.cia2.write(CIA_REGISTER.dataDirectionB, 0xf0);
    expect(connection.readHostSignals().portB).toBe(0xaf);

    memory.cia2.write(CIA_REGISTER.portA, 0x04);
    memory.cia2.write(CIA_REGISTER.dataDirectionA, 0x04);
    expect(connection.readHostSignals().portA2High).toBe(true);
    memory.cia2.write(CIA_REGISTER.portA, 0x00);
    expect(connection.readHostSignals().portA2High).toBe(false);
  });

  it('exposes the CIA2 PC handshake pulse after every Port B read or write', () => {
    const memory = new C64Memory(createFirmware());
    const connection = memory.userPort.attachDevice('handshake test device');

    memory.cia2.read(CIA_REGISTER.portB);
    expect(connection.readHostSignals().portControl2High).toBe(false);
    memory.cia2.tick(1);
    expect(connection.readHostSignals().portControl2High).toBe(true);

    memory.cia2.write(CIA_REGISTER.portB, 0x5a);
    expect(connection.readHostSignals().portControl2High).toBe(false);
    memory.cia2.tick(1);
    expect(connection.readHostSignals().portControl2High).toBe(true);
  });

  it('routes FLAG2 and external CNT2/SP2 rising edges into CIA2', () => {
    const memory = new C64Memory(createFirmware());
    const connection = memory.userPort.attachDevice('serial test device');

    connection.setSignals(deviceSignals({ cia2FlagHigh: false }));
    expect(memory.cia2.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(
      CIA_INTERRUPT_BIT.flag,
    );

    clockCia2SerialByte(connection, 0xa5);
    expect(memory.cia2.read(CIA_REGISTER.serialData)).toBe(0xa5);
    expect(memory.cia2.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.serial).toBe(
      CIA_INTERRUPT_BIT.serial,
    );
  });

  it('routes CNT1/SP1 input and both CIA serial output pairs through the connector', () => {
    const memory = new C64Memory(createFirmware());
    const connection = memory.userPort.attachDevice('dual serial test device');
    clockCia1SerialByte(connection, 0xc3);
    expect(memory.cia1.read(CIA_REGISTER.serialData)).toBe(0xc3);

    memory.cia1.write(CIA_REGISTER.timerALow, 0x00);
    memory.cia1.write(CIA_REGISTER.timerAHigh, 0x00);
    memory.cia1.write(
      CIA_REGISTER.timerAControl,
      CIA_TIMER_CONTROL_BIT.start |
        CIA_TIMER_CONTROL_BIT.forceLoad |
        CIA_TIMER_CONTROL_BIT.serialOutputMode,
    );
    memory.cia1.write(CIA_REGISTER.serialData, 0x00);
    memory.cia1.tick(4);

    expect(connection.readHostSignals().cia1SerialClockHigh).toBe(false);
    expect(connection.readHostSignals().cia1SerialDataHigh).toBe(false);
    expect(connection.readHostSignals().cia2SerialClockHigh).toBe(true);
    expect(connection.readHostSignals().cia2SerialDataHigh).toBe(true);

    memory.cia2.write(CIA_REGISTER.timerALow, 0x00);
    memory.cia2.write(CIA_REGISTER.timerAHigh, 0x00);
    memory.cia2.write(
      CIA_REGISTER.timerAControl,
      CIA_TIMER_CONTROL_BIT.start |
        CIA_TIMER_CONTROL_BIT.forceLoad |
        CIA_TIMER_CONTROL_BIT.serialOutputMode,
    );
    memory.cia2.write(CIA_REGISTER.serialData, 0x00);
    memory.cia2.tick(4);
    expect(connection.readHostSignals().cia2SerialClockHigh).toBe(false);
    expect(connection.readHostSignals().cia2SerialDataHigh).toBe(false);
  });

  it('reports board ATN and RESET levels through the connector state', () => {
    const memory = new C64Memory(createFirmware());
    const connection = memory.userPort.attachDevice('board signal observer');
    const resetLevels: boolean[] = [];
    const stopObserving = connection.observeHostSignals(({ current, previous }) => {
      if (current.resetHigh !== previous.resetHigh) resetLevels.push(current.resetHigh);
    });

    expect(connection.readHostSignals().attentionHigh).toBe(true);
    connection.setSignals(deviceSignals({ resetPulledLow: true }));
    expect(connection.readHostSignals().resetHigh).toBe(false);
    connection.setSignals(deviceSignals());
    expect(connection.readHostSignals().resetHigh).toBe(true);
    memory.resetHardware();
    expect(resetLevels).toEqual([false, true, false, true]);
    expect(connection.readHostSignals().resetHigh).toBe(true);
    stopObserving();
  });
});
