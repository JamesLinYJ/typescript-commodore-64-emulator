// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 控制端口测试
//
//   文件:       C64ControlPorts.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import {
  C64_CONTROL_PORT_DIGITAL_LINE,
  C64_CONTROL_PORT_POT_SELECT,
  C64ControlPorts,
} from '../../src/peripherals/control/C64ControlPorts';

describe('C64ControlPorts', () => {
  it('routes grounded device lines and CIA1 output pins through the correct connectors', () => {
    const ports = new C64ControlPorts();
    const port1 = ports.port1.attachDevice('joystick 1');
    const port2 = ports.port2.attachDevice('joystick 2');
    const observePort1 = vi.fn();
    port1.observeHostSignals(observePort1);

    port1.setSignals({
      groundedDigitalLines: C64_CONTROL_PORT_DIGITAL_LINE.up | C64_CONTROL_PORT_DIGITAL_LINE.fire,
      paddleXResistanceOhms: null,
      paddleYResistanceOhms: null,
    });
    port2.setSignals({
      groundedDigitalLines: C64_CONTROL_PORT_DIGITAL_LINE.right,
      paddleXResistanceOhms: null,
      paddleYResistanceOhms: null,
    });
    ports.setCia1OutputPins(0xf7, 0xee);

    expect(ports.portAExternalInputPins).toBe(0xf7);
    expect(ports.portBExternalInputPins).toBe(0xee);
    expect(port1.readHostSignals().digitalLinesHigh).toBe(0x0e);
    expect(port2.readHostSignals().digitalLinesHigh).toBe(0x17);
    expect(observePort1).toHaveBeenCalledTimes(1);
  });

  it('resolves PA6/PA7 selection and parallel paddle resistance for the SID', () => {
    const ports = new C64ControlPorts();
    const port1 = ports.port1.attachDevice('paddles 1');
    const port2 = ports.port2.attachDevice('paddles 2');
    port1.setSignals({
      groundedDigitalLines: 0,
      paddleXResistanceOhms: 235_000,
      paddleYResistanceOhms: null,
    });
    port2.setSignals({
      groundedDigitalLines: 0,
      paddleXResistanceOhms: 470_000,
      paddleYResistanceOhms: 117_500,
    });

    ports.setCia1OutputPins(C64_CONTROL_PORT_POT_SELECT.port1, 0xff);
    expect(ports.paddleInputs).toEqual({ x: 128, y: 0xff });

    ports.setCia1OutputPins(C64_CONTROL_PORT_POT_SELECT.port2, 0xff);
    expect(ports.paddleInputs).toEqual({ x: 0xff, y: 64 });

    ports.setCia1OutputPins(
      C64_CONTROL_PORT_POT_SELECT.port1 | C64_CONTROL_PORT_POT_SELECT.port2,
      0xff,
    );
    expect(ports.paddleInputs).toEqual({ x: 85, y: 64 });

    ports.setCia1OutputPins(0, 0xff);
    expect(ports.paddleInputs).toEqual({ x: 0xff, y: 0xff });
  });

  it('releases all connector lines on disconnect and rejects stale connections', () => {
    const ports = new C64ControlPorts();
    const device = ports.port1.attachDevice('temporary joystick');
    device.setSignals({
      groundedDigitalLines: C64_CONTROL_PORT_DIGITAL_LINE.down,
      paddleXResistanceOhms: 100_000,
      paddleYResistanceOhms: 200_000,
    });

    device.disconnect();

    expect(ports.port1.deviceSignals).toEqual({
      groundedDigitalLines: 0,
      paddleXResistanceOhms: null,
      paddleYResistanceOhms: null,
    });
    expect(() => device.readHostSignals()).toThrow(/no longer attached/);
    expect(() => ports.port1.attachDevice('replacement')).not.toThrow();
  });

  it('rejects invalid masks and electrical values instead of silently normalizing them', () => {
    const ports = new C64ControlPorts();
    const device = ports.port1.attachDevice('invalid device');

    expect(() =>
      device.setSignals({
        groundedDigitalLines: 0x20,
        paddleXResistanceOhms: null,
        paddleYResistanceOhms: null,
      }),
    ).toThrow(/five control-port digital-line bits/);
    expect(() =>
      device.setSignals({
        groundedDigitalLines: 0,
        paddleXResistanceOhms: Number.NaN,
        paddleYResistanceOhms: null,
      }),
    ).toThrow(/finite non-negative/);
  });
});
