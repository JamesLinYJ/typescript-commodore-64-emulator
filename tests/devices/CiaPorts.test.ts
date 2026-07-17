// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA 端口接线测试
//
//   文件:       CiaPorts.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { Cia1 } from '../../src/devices/Cia1';
import { Cia2 } from '../../src/devices/Cia2';
import { CIA_REGISTER } from '../../src/devices/ciaRegisters';
import { IecBus, IEC_LINE } from '../../src/peripherals/iec/IecBus';

const RELEASED_PADDLE_LINES = {
  paddleXResistanceOhms: null,
  paddleYResistanceOhms: null,
} as const;

function readKeyboardPortConfigurations(cia: Cia1): readonly number[] {
  const results: number[] = [];
  const sample = (): void => {
    results.push(cia.read(CIA_REGISTER.portA), cia.read(CIA_REGISTER.portB));
  };

  cia.write(CIA_REGISTER.dataDirectionA, 0xff);
  cia.write(CIA_REGISTER.dataDirectionB, 0x00);
  cia.write(CIA_REGISTER.portA, 0x00);
  sample();

  cia.write(CIA_REGISTER.dataDirectionA, 0x00);
  cia.write(CIA_REGISTER.dataDirectionB, 0xff);
  cia.write(CIA_REGISTER.portB, 0x00);
  sample();

  cia.write(CIA_REGISTER.dataDirectionA, 0x00);
  cia.write(CIA_REGISTER.dataDirectionB, 0x00);
  sample();

  cia.write(CIA_REGISTER.dataDirectionA, 0xff);
  cia.write(CIA_REGISTER.dataDirectionB, 0xff);
  cia.write(CIA_REGISTER.portA, 0x00);
  cia.write(CIA_REGISTER.portB, 0x00);
  sample();

  cia.write(CIA_REGISTER.portA, 0x00);
  cia.write(CIA_REGISTER.portB, 0xff);
  sample();

  cia.write(CIA_REGISTER.portA, 0xff);
  cia.write(CIA_REGISTER.portB, 0x00);
  sample();

  cia.write(CIA_REGISTER.portA, 0xff);
  cia.write(CIA_REGISTER.portB, 0xff);
  sample();
  return results;
}

describe('C64 CIA port wiring', () => {
  it('scans the keyboard matrix in both directions', () => {
    const cia = new Cia1();
    cia.keyboard.setKeyState('KeyA', true);

    cia.write(CIA_REGISTER.dataDirectionA, 0xff);
    cia.write(CIA_REGISTER.portA, 0xfd);
    expect(cia.read(CIA_REGISTER.portB)).toBe(0xfb);

    cia.write(CIA_REGISTER.dataDirectionA, 0x00);
    cia.write(CIA_REGISTER.dataDirectionB, 0xff);
    cia.write(CIA_REGISTER.portB, 0xfb);
    expect(cia.read(CIA_REGISTER.portA)).toBe(0xfd);
  });

  it.each([
    {
      expected: [
        0x00, 0xef, 0x7f, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x7f, 0x00, 0xff, 0xff,
      ],
      keys: ['Space'],
      name: 'SPACE',
    },
    {
      expected: [
        0x00, 0x7f, 0xfd, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0xfd, 0x00, 0xff, 0xff,
      ],
      keys: ['ShiftLeft'],
      name: 'left SHIFT',
    },
    {
      expected: [
        0x00, 0xef, 0xbf, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0xbf, 0x00, 0xff, 0xff,
      ],
      keys: ['ShiftRight'],
      name: 'right SHIFT',
    },
    {
      expected: [
        0x00, 0x6f, 0xbd, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0xbd, 0x00, 0xff, 0xff,
      ],
      keys: ['ShiftLeft', 'ShiftRight'],
      name: 'both SHIFT keys',
    },
    {
      expected: [
        0x00, 0x7f, 0xfd, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x7f, 0xfd, 0x00, 0xff, 0xff,
      ],
      keys: ['ShiftLock'],
      name: 'SHIFT LOCK',
    },
    {
      expected: [
        0x00, 0x6f, 0xbd, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x7f, 0xbd, 0x00, 0xff, 0xff,
      ],
      keys: ['ShiftLock', 'ShiftRight'],
      name: 'SHIFT LOCK and right SHIFT',
    },
  ])('matches the real-machine CIA port vector for $name', ({ expected, keys }) => {
    const cia = new Cia1();
    for (const key of keys) cia.keyboard.setKeyState(key, true);

    expect(readKeyboardPortConfigurations(cia)).toEqual(expected);
  });

  it('routes joystick ports two and one to CIA1 ports A and B', () => {
    const cia = new Cia1();
    const port1 = cia.controlPorts.port1.attachDevice('test joystick 1');
    const port2 = cia.controlPorts.port2.attachDevice('test joystick 2');
    port1.setSignals({
      ...RELEASED_PADDLE_LINES,
      groundedDigitalLines: 0x05,
    });
    port2.setSignals({
      ...RELEASED_PADDLE_LINES,
      groundedDigitalLines: 0x12,
    });

    expect(cia.read(CIA_REGISTER.portA)).toBe(0xed);
    expect(cia.read(CIA_REGISTER.portB)).toBe(0xfa);
  });

  it('selects the VIC-II bank from the inverted CIA2 PA0 and PA1 pins', () => {
    const cia = new Cia2();
    expect(cia.vicBankAddress).toBe(0x0000);

    cia.write(CIA_REGISTER.dataDirectionA, 0x03);
    cia.write(CIA_REGISTER.portA, 0x00);
    expect(cia.vicBankAddress).toBe(0xc000);

    cia.write(CIA_REGISTER.portA, 0x02);
    expect(cia.vicBankAddress).toBe(0x4000);
  });

  it('routes CIA2 PA3..PA7 through the C64 IEC inverter and open-collector bus', () => {
    const bus = new IecBus();
    const drive = bus.attach('1541 #8');
    const cia = new Cia2({ iecBus: bus });

    // PA6/PA7 是总线采样输入：IEC 空闲高电平读回 1，被外设拉低后读回 0。
    expect(cia.read(CIA_REGISTER.portA)).toBe(0xff);
    drive.setPulledLowLines([IEC_LINE.clock, IEC_LINE.data]);
    expect(cia.read(CIA_REGISTER.portA) & 0xc0).toBe(0x00);

    drive.releaseAll();
    cia.write(CIA_REGISTER.dataDirectionA, 0x38);
    cia.write(CIA_REGISTER.portA, 0x00);
    expect(bus.state).toMatchObject({
      attentionHigh: true,
      clockHigh: true,
      dataHigh: true,
    });

    // PA3..PA5 的高电平经过 7406 反相开集电极驱动器后，把对应 IEC 线拉低。
    cia.write(CIA_REGISTER.portA, 0x38);
    expect(bus.state).toMatchObject({
      attentionHigh: false,
      clockHigh: false,
      dataHigh: false,
    });
    expect(cia.read(CIA_REGISTER.portA) & 0xc0).toBe(0x00);

    cia.reset();
    expect(bus.state).toMatchObject({
      attentionHigh: true,
      clockHigh: true,
      dataHigh: true,
    });
  });

  it('drives IEC RESET from the separate C64 system-reset input', () => {
    const bus = new IecBus();
    const cia = new Cia2({ iecBus: bus });

    cia.setSerialBusResetAsserted(true);
    expect(bus.state.resetHigh).toBe(false);

    cia.reset();
    expect(bus.state.resetHigh).toBe(false);

    cia.setSerialBusResetAsserted(false);
    expect(bus.state.resetHigh).toBe(true);
  });
});
