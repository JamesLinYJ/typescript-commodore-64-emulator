// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 浏览器输入适配器测试
//
//   文件:       BrowserC64Input.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { C64KeyboardMatrix } from '../../src/devices/C64KeyboardMatrix';
import {
  RESTORE_NMI_PULSE_CYCLES,
  RestoreKeyNmiCircuit,
} from '../../src/devices/RestoreKeyNmiCircuit';
import { BrowserC64Input } from '../../src/platform/BrowserC64Input';
import {
  C64_CONTROL_PORT_DIGITAL_LINE,
  C64ControlPorts,
} from '../../src/peripherals/control/C64ControlPorts';

function createInput(joystickPort: 1 | 2 | null = 2): {
  readonly controlPorts: C64ControlPorts;
  readonly input: BrowserC64Input;
  readonly keyboard: C64KeyboardMatrix;
  readonly restore: RestoreKeyNmiCircuit;
  readonly target: EventTarget;
} {
  const controlPorts = new C64ControlPorts();
  const keyboard = new C64KeyboardMatrix();
  const restore = new RestoreKeyNmiCircuit();
  const input = new BrowserC64Input({
    controlPorts,
    joystickPort,
    keyboard,
    restoreKeyInput: restore,
  });
  const target = new EventTarget();
  input.attach(target);
  return { controlPorts, input, keyboard, restore, target };
}

function scanPortB(keyboard: C64KeyboardMatrix, portAOutput: number): number {
  return keyboard.resolvePortInputs({
    portA: {
      dataDirection: 0xff,
      externalInputPins: 0xff,
      outputPins: portAOutput,
    },
    portB: {
      dataDirection: 0x00,
      externalInputPins: 0xff,
      outputPins: 0xff,
    },
  }).portB;
}

describe('BrowserC64Input', () => {
  it('maps a direction key to only the selected joystick port', () => {
    const { controlPorts, input, keyboard, target } = createInput(2);

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));

    expect(controlPorts.port2.deviceSignals.groundedDigitalLines).toBe(
      C64_CONTROL_PORT_DIGITAL_LINE.up,
    );
    expect(scanPortB(keyboard, 0xfe)).toBe(0xff);

    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp' }));
    expect(controlPorts.port2.deviceSignals.groundedDigitalLines).toBe(0);
    input.dispose();
  });

  it('synthesizes shifted C64 keys when joystick keyboard mapping is disabled', () => {
    const { input, keyboard, target } = createInput(null);

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
    expect(scanPortB(keyboard, 0xfe)).toBe(0x7f);
    expect(scanPortB(keyboard, 0xfd)).toBe(0x7f);

    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp' }));
    expect(scanPortB(keyboard, 0xfe)).toBe(0xff);
    expect(scanPortB(keyboard, 0xfd)).toBe(0xff);
    input.dispose();
  });

  it('reference-counts host keys that share one physical matrix switch', () => {
    const { input, keyboard, target } = createInput(null);
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltLeft' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'AltRight' }));
    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltLeft' }));

    expect(scanPortB(keyboard, 0x7f)).toBe(0xdf);

    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'AltRight' }));
    expect(scanPortB(keyboard, 0x7f)).toBe(0xff);
    input.dispose();
  });

  it('maps Caps Lock to the mechanically latched C64 Shift Lock switch', () => {
    const { input, keyboard, target } = createInput(null);

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock' }));
    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'CapsLock' }));
    expect(scanPortB(keyboard, 0xfd)).toBe(0x7f);

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock' }));
    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'CapsLock' }));
    expect(scanPortB(keyboard, 0xfd)).toBe(0xff);

    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'CapsLock' }));
    input.detach();
    expect(scanPortB(keyboard, 0xfd)).toBe(0xff);
    input.dispose();
  });

  it('routes PageUp edges to RESTORE without retriggering key-repeat events', () => {
    const { input, restore, target } = createInput(null);
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageUp' }));
    expect(restore.nmiAsserted).toBe(true);

    restore.tick(RESTORE_NMI_PULSE_CYCLES);
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageUp', repeat: true }));
    expect(restore.nmiAsserted).toBe(false);

    target.dispatchEvent(new KeyboardEvent('keyup', { code: 'PageUp' }));
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageUp' }));
    expect(restore.nmiAsserted).toBe(true);
    input.dispose();
  });

  it('releases held lines before moving the browser joystick to another port', () => {
    const { controlPorts, input, target } = createInput(2);
    target.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));

    input.setActiveJoystickPort(1);

    expect(controlPorts.port2.deviceAttached).toBe(false);
    expect(controlPorts.port2.deviceSignals.groundedDigitalLines).toBe(0);
    expect(controlPorts.port1.deviceAttached).toBe(true);
    expect(controlPorts.port1.deviceSignals.groundedDigitalLines).toBe(0);
    input.dispose();
  });
});
