// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA1 键盘与控制端口接线
//
//   文件:       Cia1.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { C64KeyboardMatrix, type KeyboardPortInputs } from './C64KeyboardMatrix';
import { Mos6526, type Mos6526Options } from './Mos6526';
import {
  C64_CONTROL_PORT_DIGITAL_LINE,
  C64ControlPorts,
} from '../peripherals/control/C64ControlPorts';
import type { C64UserPort } from '../peripherals/userport/C64UserPort';

export interface C64LightPenInput {
  setLightPenInputHigh(high: boolean): void;
}

export interface Cia1Options extends Mos6526Options {
  readonly controlPorts?: C64ControlPorts;
  readonly lightPenInput?: C64LightPenInput;
  readonly userPort?: C64UserPort;
}

export class Cia1 extends Mos6526 {
  readonly controlPorts: C64ControlPorts;
  readonly keyboard: C64KeyboardMatrix;
  private controlPortsValue: C64ControlPorts | undefined;
  private lightPenInputValue: C64LightPenInput | undefined;
  private userPortValue: C64UserPort | undefined;

  constructor(options: Cia1Options = {}) {
    const { controlPorts, lightPenInput, userPort, ...mos6526Options } = options;
    super('CIA1', mos6526Options);
    this.keyboard = new C64KeyboardMatrix();
    this.controlPorts = controlPorts ?? new C64ControlPorts();
    this.controlPortsValue = this.controlPorts;
    this.lightPenInputValue = lightPenInput;
    this.userPortValue = userPort;
    this.keyboard.observeChanges(() => this.synchronizeLightPenInput());
    this.controlPorts.observeDeviceSignals(() => this.synchronizeLightPenInput());
    this.synchronizeControlPortOutputs();
    this.synchronizeLightPenInput();
    this.userPortValue?.setCia1SerialOutputs(this.serialClockOutputHigh, this.serialDataOutputHigh);
  }

  protected override readPortAExternalInputs(portAOutput: number, portBOutput: number): number {
    return this.resolveKeyboardAndControlPortInputs(portAOutput, portBOutput).portA;
  }

  protected override readPortBExternalInputs(portAOutput: number, portBOutput: number): number {
    return this.resolveKeyboardAndControlPortInputs(portAOutput, portBOutput).portB;
  }

  protected override onPortAOutputChanged(): void {
    this.synchronizeControlPortOutputs();
    this.synchronizeLightPenInput();
  }

  protected override onPortBOutputChanged(): void {
    this.synchronizeControlPortOutputs();
    this.synchronizeLightPenInput();
  }

  protected override onSerialOutputChanged(clockHigh: boolean, dataHigh: boolean): void {
    this.userPortValue?.setCia1SerialOutputs(clockHigh, dataHigh);
  }

  private resolveKeyboardAndControlPortInputs(
    portAOutput: number,
    portBOutput: number,
  ): KeyboardPortInputs {
    const controlPorts = this.controlPortsValue;
    return this.keyboard.resolvePortInputs({
      portA: {
        dataDirection: this.portADataDirection,
        externalInputPins: controlPorts?.portAExternalInputPins ?? 0xff,
        outputPins: portAOutput,
      },
      portB: {
        dataDirection: this.portBDataDirection,
        externalInputPins: controlPorts?.portBExternalInputPins ?? 0xff,
        outputPins: portBOutput,
      },
    });
  }

  private synchronizeControlPortOutputs(): void {
    this.controlPortsValue?.setCia1OutputPins(this.portAOutputPins, this.portBOutputPins);
  }

  private synchronizeLightPenInput(): void {
    const lightPenInput = this.lightPenInputValue;
    if (!lightPenInput) return;
    const inputs = this.resolveKeyboardAndControlPortInputs(
      this.portAOutputPins,
      this.portBOutputPins,
    );
    lightPenInput.setLightPenInputHigh((inputs.portB & C64_CONTROL_PORT_DIGITAL_LINE.fire) !== 0);
  }
}
