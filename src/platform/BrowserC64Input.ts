// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 浏览器输入适配器
//
//   文件:       BrowserC64Input.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { C64KeyboardMatrix } from '../devices/C64KeyboardMatrix';
import type { RestoreKeyInput } from '../devices/RestoreKeyNmiCircuit';
import {
  C64_CONTROL_PORT_DIGITAL_LINE,
  type C64ControlPortDeviceConnection,
  type C64ControlPortNumber,
  type C64ControlPorts,
} from '../peripherals/control/C64ControlPorts';

export interface BrowserC64InputOptions {
  readonly controlPorts: C64ControlPorts;
  readonly joystickPort?: C64ControlPortNumber | null;
  readonly keyboard: C64KeyboardMatrix;
  readonly restoreKeyInput: RestoreKeyInput;
}

interface ActiveHostBinding {
  readonly joystickBit?: number;
  readonly matrixCodes?: readonly string[];
  readonly restore?: true;
  readonly shiftLockToggle?: true;
}

const JOYSTICK_BINDINGS = new Map<string, number>([
  ['ArrowUp', C64_CONTROL_PORT_DIGITAL_LINE.up],
  ['Numpad8', C64_CONTROL_PORT_DIGITAL_LINE.up],
  ['ArrowDown', C64_CONTROL_PORT_DIGITAL_LINE.down],
  ['Numpad2', C64_CONTROL_PORT_DIGITAL_LINE.down],
  ['ArrowLeft', C64_CONTROL_PORT_DIGITAL_LINE.left],
  ['Numpad4', C64_CONTROL_PORT_DIGITAL_LINE.left],
  ['ArrowRight', C64_CONTROL_PORT_DIGITAL_LINE.right],
  ['Numpad6', C64_CONTROL_PORT_DIGITAL_LINE.right],
  ['Space', C64_CONTROL_PORT_DIGITAL_LINE.fire],
  ['Numpad0', C64_CONTROL_PORT_DIGITAL_LINE.fire],
]);

const SHIFTED_MATRIX_BINDINGS = new Map<string, readonly string[]>([
  ['ArrowUp', ['ShiftLeft', 'ArrowDown']],
  ['ArrowLeft', ['ShiftLeft', 'ArrowRight']],
  ['F2', ['ShiftLeft', 'F1']],
  ['F4', ['ShiftLeft', 'F3']],
  ['F6', ['ShiftLeft', 'F5']],
  ['F8', ['ShiftLeft', 'F7']],
]);

const RELEASED_JOYSTICK_SIGNALS = {
  groundedDigitalLines: 0,
  paddleXResistanceOhms: null,
  paddleYResistanceOhms: null,
} as const;

/**
 * 把浏览器 KeyboardEvent 映射到三个彼此独立的硬件入口：键盘矩阵、控制端口和
 * RESTORE 单稳态电路。适配器记录每个主机按键的实际绑定，避免按键重复与端口切换
 * 造成粘键，也避免同一次方向键事件同时驱动键盘和操纵杆。
 */
export class BrowserC64Input {
  private readonly controlPorts: C64ControlPorts;
  private readonly keyboard: C64KeyboardMatrix;
  private readonly restoreKeyInput: RestoreKeyInput;
  private readonly activeBindings = new Map<string, ActiveHostBinding>();
  private readonly matrixPressCounts = new Map<string, number>();
  private readonly joystickPressCounts = new Map<number, number>();
  private joystickConnection: C64ControlPortDeviceConnection | undefined;
  private joystickGroundedLines = 0;
  private joystickPortValue: C64ControlPortNumber | null = null;
  private shiftLockLatched = false;
  private target: EventTarget | undefined;

  private readonly handleKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    const existing = this.activeBindings.get(event.code);
    if (existing) {
      event.preventDefault();
      return;
    }

    const binding = this.createBinding(event.code);
    if (!binding) return;
    this.activeBindings.set(event.code, binding);
    this.activateBinding(binding);
    event.preventDefault();
  };

  private readonly handleKeyUp = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    const binding = this.activeBindings.get(event.code);
    if (!binding) return;
    this.activeBindings.delete(event.code);
    this.releaseBinding(binding);
    event.preventDefault();
  };

  constructor(options: BrowserC64InputOptions) {
    this.controlPorts = options.controlPorts;
    this.keyboard = options.keyboard;
    this.restoreKeyInput = options.restoreKeyInput;
    this.setActiveJoystickPort(options.joystickPort === undefined ? 2 : options.joystickPort);
  }

  get activeJoystickPort(): C64ControlPortNumber | null {
    return this.joystickPortValue;
  }

  get isAttached(): boolean {
    return this.target !== undefined;
  }

  attach(target: EventTarget): void {
    if (this.target === target) return;
    this.detach();
    this.target = target;
    target.addEventListener('keydown', this.handleKeyDown);
    target.addEventListener('keyup', this.handleKeyUp);
  }

  detach(): void {
    if (this.target) {
      this.target.removeEventListener('keydown', this.handleKeyDown);
      this.target.removeEventListener('keyup', this.handleKeyUp);
    }
    this.target = undefined;
    this.releaseAllBindings();
    this.setShiftLockLatched(false);
  }

  dispose(): void {
    this.detach();
    this.joystickConnection?.disconnect();
    this.joystickConnection = undefined;
    this.joystickPortValue = null;
  }

  setActiveJoystickPort(port: C64ControlPortNumber | null): void {
    if (this.joystickPortValue === port) return;
    this.releaseAllBindings();
    this.joystickConnection?.disconnect();
    this.joystickConnection = undefined;
    this.joystickPortValue = port;
    this.joystickGroundedLines = 0;
    if (port === null) return;

    const controlPort = port === 1 ? this.controlPorts.port1 : this.controlPorts.port2;
    this.joystickConnection = controlPort.attachDevice('Browser keyboard joystick');
    this.joystickConnection.setSignals(RELEASED_JOYSTICK_SIGNALS);
  }

  private createBinding(code: string): ActiveHostBinding | undefined {
    if (code === 'PageUp') return { restore: true };
    if (code === 'CapsLock') return { shiftLockToggle: true };

    if (this.joystickConnection) {
      const joystickBit = JOYSTICK_BINDINGS.get(code);
      if (joystickBit !== undefined) return { joystickBit };
    }

    const shiftedCodes = SHIFTED_MATRIX_BINDINGS.get(code);
    if (shiftedCodes) return { matrixCodes: shiftedCodes };
    if (this.keyboard.supportsKey(code)) return { matrixCodes: [code] };
    return undefined;
  }

  private activateBinding(binding: ActiveHostBinding): void {
    if (binding.restore) this.restoreKeyInput.setRestoreKeyPressed(true);
    if (binding.shiftLockToggle) this.setShiftLockLatched(!this.shiftLockLatched);
    if (binding.joystickBit !== undefined) this.pressJoystickBit(binding.joystickBit);
    if (binding.matrixCodes) {
      for (const code of binding.matrixCodes) this.pressMatrixCode(code);
    }
  }

  private releaseBinding(binding: ActiveHostBinding): void {
    if (binding.restore) this.restoreKeyInput.setRestoreKeyPressed(false);
    if (binding.joystickBit !== undefined) this.releaseJoystickBit(binding.joystickBit);
    if (binding.matrixCodes) {
      for (const code of binding.matrixCodes) this.releaseMatrixCode(code);
    }
  }

  private releaseAllBindings(): void {
    for (const binding of this.activeBindings.values()) this.releaseBinding(binding);
    this.activeBindings.clear();
    this.matrixPressCounts.clear();
    this.joystickPressCounts.clear();
    this.joystickGroundedLines = 0;
    this.updateJoystickSignals();
    this.restoreKeyInput.setRestoreKeyPressed(false);
  }

  private pressMatrixCode(code: string): void {
    const count = this.matrixPressCounts.get(code) ?? 0;
    this.matrixPressCounts.set(code, count + 1);
    if (count === 0) this.keyboard.setKeyState(code, true);
  }

  private releaseMatrixCode(code: string): void {
    const count = this.matrixPressCounts.get(code);
    if (count === undefined || count === 0) {
      throw new Error(`Browser input matrix binding for ${code} was released without a press.`);
    }
    if (count === 1) {
      this.matrixPressCounts.delete(code);
      this.keyboard.setKeyState(code, false);
      return;
    }
    this.matrixPressCounts.set(code, count - 1);
  }

  private pressJoystickBit(bit: number): void {
    const count = this.joystickPressCounts.get(bit) ?? 0;
    this.joystickPressCounts.set(bit, count + 1);
    if (count !== 0) return;
    this.joystickGroundedLines |= bit;
    this.updateJoystickSignals();
  }

  private releaseJoystickBit(bit: number): void {
    const count = this.joystickPressCounts.get(bit);
    if (count === undefined || count === 0) {
      throw new Error(`Browser joystick binding for bit ${bit} was released without a press.`);
    }
    if (count > 1) {
      this.joystickPressCounts.set(bit, count - 1);
      return;
    }
    this.joystickPressCounts.delete(bit);
    this.joystickGroundedLines &= ~bit;
    this.updateJoystickSignals();
  }

  private updateJoystickSignals(): void {
    this.joystickConnection?.setSignals({
      ...RELEASED_JOYSTICK_SIGNALS,
      groundedDigitalLines: this.joystickGroundedLines,
    });
  }

  private setShiftLockLatched(latched: boolean): void {
    if (this.shiftLockLatched === latched) return;
    this.shiftLockLatched = latched;
    this.keyboard.setKeyState('ShiftLock', latched);
  }
}
