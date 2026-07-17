// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6522 VIA
//
//   文件:       Mos6522.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte, word } from '../shared/numbers';
import { IoDevice } from './IoDevice';
import {
  MOS_6522_ACR_BIT,
  MOS_6522_CONTROL_LINE,
  MOS_6522_INTERRUPT_BIT,
  MOS_6522_PCR_CONTROL_MODE,
  MOS_6522_REGISTER,
  MOS_6522_REGISTER_COUNT,
  MOS_6522_SHIFT_MODE,
  type Mos6522ControlLine,
  type Mos6522ShiftMode,
} from './Mos6522Registers';

const FINISHED_SHIFT_PHASE = 16;
const PORT_B_7_BIT = 1 << 7;

export class Mos6522 extends IoDevice {
  private timer1Counter = 0xffff;
  private timer1Latch = 0xffff;
  private timer1Running = false;
  private timer1IrqArmed = false;
  private timer1ReloadPending = false;
  private timer1StartDelay = 0;
  private timer1PortB7High = true;
  private timer2Counter = 0xffff;
  private timer2LowLatch = 0xff;
  private timer2Running = false;
  private timer2IrqArmed = false;
  private timer2StartDelay = 0;
  private interruptFlags = 0;
  private interruptEnable = 0;
  private latchedPortA = 0xff;
  private latchedPortB = 0xff;
  private portB6High = true;
  private shiftPhase = FINISHED_SHIFT_PHASE;
  private shiftStartDelay = 0;
  private ca1High = true;
  private ca2InputHigh = true;
  private cb1High = true;
  private cb2InputHigh = true;
  private ca2OutputHigh = true;
  private cb2OutputHigh = true;
  private ca2PulseCyclesRemaining = 0;
  private cb2PulseCyclesRemaining = 0;

  constructor(deviceName = 'MOS 6522', debug = false) {
    super(deviceName, MOS_6522_REGISTER_COUNT, debug);
    this.installRegisterMap();
    this.reset();
  }

  get interruptPending(): boolean {
    return (this.interruptFlags & this.interruptEnable & MOS_6522_INTERRUPT_BIT.sourceMask) !== 0;
  }

  get portAOutputPins(): number {
    const output = this.registers[MOS_6522_REGISTER.portA] ?? 0;
    const direction = this.registers[MOS_6522_REGISTER.dataDirectionA] ?? 0;
    return byte((output & direction) | ~direction);
  }

  get portBOutputLatch(): number {
    return this.registers[MOS_6522_REGISTER.portB] ?? 0;
  }

  get portBDataDirection(): number {
    return this.registers[MOS_6522_REGISTER.dataDirectionB] ?? 0;
  }

  get portBOutputPins(): number {
    const output = this.portBOutputLatch;
    const direction = this.portBDataDirection;
    let pins = byte((output & direction) | ~direction);
    if (this.timer1ControlsPortB7()) {
      pins = this.timer1PortB7High ? pins | PORT_B_7_BIT : pins & ~PORT_B_7_BIT;
    }
    return byte(pins);
  }

  reset(): void {
    this.registers.fill(0);
    this.timer1Counter = 0xffff;
    this.timer1Latch = 0xffff;
    this.timer1Running = false;
    this.timer1IrqArmed = false;
    this.timer1ReloadPending = false;
    this.timer1StartDelay = 0;
    this.timer1PortB7High = true;
    this.timer2Counter = 0xffff;
    this.timer2LowLatch = 0xff;
    this.timer2Running = false;
    this.timer2IrqArmed = false;
    this.timer2StartDelay = 0;
    this.interruptFlags = 0;
    this.interruptEnable = 0;
    this.latchedPortA = 0xff;
    this.latchedPortB = 0xff;
    this.portB6High = true;
    this.shiftPhase = FINISHED_SHIFT_PHASE;
    this.shiftStartDelay = 0;
    this.ca1High = true;
    this.ca2InputHigh = true;
    this.cb1High = true;
    this.cb2InputHigh = true;
    this.ca2OutputHigh = true;
    this.cb2OutputHigh = true;
    this.ca2PulseCyclesRemaining = 0;
    this.cb2PulseCyclesRemaining = 0;
    this.onPortAOutputChanged(this.portAOutputPins);
    this.onPortBOutputChanged(this.portBOutputPins);
    this.onControlLineOutputChanged(MOS_6522_CONTROL_LINE.ca2, true);
    this.onControlLineOutputChanged(MOS_6522_CONTROL_LINE.cb2, true);
  }

  tick(cycles: number): boolean {
    const elapsedCycles = Math.max(0, Math.trunc(cycles));
    for (let cycle = 0; cycle < elapsedCycles; cycle += 1) {
      this.tickTimer1();
      this.tickTimer2();
      this.tickProcessorClockShift();
      this.tickControlLinePulses();
    }
    return this.interruptPending;
  }

  signalControlLine(line: Mos6522ControlLine, high: boolean): void {
    switch (line) {
      case MOS_6522_CONTROL_LINE.ca1: {
        const previous = this.ca1High;
        this.ca1High = high;
        if (previous !== high && this.isCa1ActiveEdge(previous, high)) this.handleCa1Edge();
        return;
      }
      case MOS_6522_CONTROL_LINE.ca2: {
        const previous = this.ca2InputHigh;
        this.ca2InputHigh = high;
        if (previous !== high && this.isCa2InputMode()) {
          if (this.isControlModeActiveEdge(this.ca2ControlMode(), previous, high)) {
            this.raiseInterrupt(MOS_6522_INTERRUPT_BIT.ca2);
          }
        }
        return;
      }
      case MOS_6522_CONTROL_LINE.cb1: {
        const previous = this.cb1High;
        this.cb1High = high;
        if (previous !== high) {
          this.handleExternalShiftClock(high);
          if (this.isCb1ActiveEdge(previous, high)) this.handleCb1Edge();
        }
        return;
      }
      case MOS_6522_CONTROL_LINE.cb2: {
        const previous = this.cb2InputHigh;
        this.cb2InputHigh = high;
        if (previous !== high && this.isCb2InputMode()) {
          if (this.isControlModeActiveEdge(this.cb2ControlMode(), previous, high)) {
            this.raiseInterrupt(MOS_6522_INTERRUPT_BIT.cb2);
          }
        }
      }
    }
  }

  signalPortB6(high: boolean): void {
    const fallingEdge = this.portB6High && !high;
    this.portB6High = high;
    if (fallingEdge && this.timer2CountsPortB6()) this.stepTimer2Counter();
  }

  protected readPortAExternalInputs(portAOutput: number, portBOutput: number): number {
    void portAOutput;
    void portBOutput;
    return 0xff;
  }

  protected readPortBExternalInputs(portAOutput: number, portBOutput: number): number {
    void portAOutput;
    void portBOutput;
    return 0xff;
  }

  protected onPortAOutputChanged(pins: number): void {
    void pins;
  }

  protected onPortBOutputChanged(pins: number): void {
    void pins;
  }

  protected onControlLineOutputChanged(line: Mos6522ControlLine, high: boolean): void {
    void line;
    void high;
  }

  protected onPortAAccess(kind: 'read' | 'write', handshake: boolean): void {
    void kind;
    void handshake;
  }

  protected onPortBAccess(kind: 'read' | 'write', handshake: boolean): void {
    void kind;
    void handshake;
  }

  private installRegisterMap(): void {
    this.mapRegister(MOS_6522_REGISTER.portB, {
      read: () => this.readPortB(true),
      write: (_index, value) => this.writePortB(value, true),
    });
    this.mapRegister(MOS_6522_REGISTER.portA, {
      read: () => this.readPortA(true),
      write: (_index, value) => this.writePortA(value, true),
    });
    this.mapRegister(MOS_6522_REGISTER.dataDirectionB, {
      write: (index, value) => {
        this.registers[index] = value;
        this.onPortBOutputChanged(this.portBOutputPins);
      },
    });
    this.mapRegister(MOS_6522_REGISTER.dataDirectionA, {
      write: (index, value) => {
        this.registers[index] = value;
        this.onPortAOutputChanged(this.portAOutputPins);
      },
    });
    this.mapRegister(MOS_6522_REGISTER.timer1CounterLow, {
      read: () => {
        this.clearInterrupt(MOS_6522_INTERRUPT_BIT.timer1);
        return byte(this.timer1Counter);
      },
      write: (_index, value) => this.writeTimer1LatchLow(value),
    });
    this.mapRegister(MOS_6522_REGISTER.timer1CounterHigh, {
      read: () => byte(this.timer1Counter >>> 8),
      write: (_index, value) => this.startTimer1(value),
    });
    this.mapRegister(MOS_6522_REGISTER.timer1LatchLow, {
      read: () => byte(this.timer1Latch),
      write: (_index, value) => this.writeTimer1LatchLow(value),
    });
    this.mapRegister(MOS_6522_REGISTER.timer1LatchHigh, {
      read: () => byte(this.timer1Latch >>> 8),
      write: (_index, value) => {
        this.timer1Latch = (this.timer1Latch & 0x00ff) | (value << 8);
        this.clearInterrupt(MOS_6522_INTERRUPT_BIT.timer1);
      },
    });
    this.mapRegister(MOS_6522_REGISTER.timer2CounterLow, {
      read: () => {
        this.clearInterrupt(MOS_6522_INTERRUPT_BIT.timer2);
        return byte(this.timer2Counter);
      },
      write: (_index, value) => {
        this.timer2LowLatch = value;
      },
    });
    this.mapRegister(MOS_6522_REGISTER.timer2CounterHigh, {
      read: () => byte(this.timer2Counter >>> 8),
      write: (_index, value) => this.startTimer2(value),
    });
    this.mapRegister(MOS_6522_REGISTER.shiftRegister, {
      read: (index) => {
        this.clearInterrupt(MOS_6522_INTERRUPT_BIT.shiftRegister);
        this.startShiftTransfer();
        return this.registers[index] ?? 0;
      },
      write: (index, value) => {
        this.registers[index] = value;
        this.clearInterrupt(MOS_6522_INTERRUPT_BIT.shiftRegister);
        this.startShiftTransfer();
      },
    });
    this.mapRegister(MOS_6522_REGISTER.auxiliaryControl, {
      write: (index, value) => this.writeAuxiliaryControl(index, value),
    });
    this.mapRegister(MOS_6522_REGISTER.peripheralControl, {
      write: (index, value) => this.writePeripheralControl(index, value),
    });
    this.mapRegister(MOS_6522_REGISTER.interruptFlags, {
      read: () => this.interruptFlags | (this.interruptPending ? MOS_6522_INTERRUPT_BIT.any : 0),
      write: (_index, value) => {
        this.interruptFlags &= ~(value & MOS_6522_INTERRUPT_BIT.sourceMask);
      },
    });
    this.mapRegister(MOS_6522_REGISTER.interruptEnable, {
      read: () => this.interruptEnable | MOS_6522_INTERRUPT_BIT.any,
      write: (_index, value) => {
        const selected = value & MOS_6522_INTERRUPT_BIT.sourceMask;
        if ((value & MOS_6522_INTERRUPT_BIT.any) !== 0) this.interruptEnable |= selected;
        else this.interruptEnable &= ~selected;
      },
    });
    this.mapRegister(MOS_6522_REGISTER.portAWithoutHandshake, {
      read: () => this.readPortA(false),
      write: (_index, value) => this.writePortA(value, false),
    });
  }

  private readPortA(handshake: boolean): number {
    if (handshake) this.handlePortAHandshake();
    const direction = this.registers[MOS_6522_REGISTER.dataDirectionA] ?? 0;
    const output = this.registers[MOS_6522_REGISTER.portA] ?? 0;
    const external =
      (this.registers[MOS_6522_REGISTER.auxiliaryControl] ?? 0) & MOS_6522_ACR_BIT.portAInputLatch
        ? this.latchedPortA
        : this.readPortAExternalInputs(this.portAOutputPins, this.portBOutputPins);
    const value = byte((external & ~direction) | (output & direction));
    this.onPortAAccess('read', handshake);
    return value;
  }

  private readPortB(handshake: boolean): number {
    if (handshake) this.handlePortBHandshake();
    const direction = this.registers[MOS_6522_REGISTER.dataDirectionB] ?? 0;
    const output = this.registers[MOS_6522_REGISTER.portB] ?? 0;
    const external =
      (this.registers[MOS_6522_REGISTER.auxiliaryControl] ?? 0) & MOS_6522_ACR_BIT.portBInputLatch
        ? this.latchedPortB
        : this.readPortBExternalInputs(this.portAOutputPins, this.portBOutputPins);
    let value = byte((external & ~direction) | (output & direction));
    if (this.timer1ControlsPortB7()) {
      value = this.timer1PortB7High ? value | PORT_B_7_BIT : value & ~PORT_B_7_BIT;
    }
    const result = byte(value);
    this.onPortBAccess('read', handshake);
    return result;
  }

  private writePortA(value: number, handshake: boolean): void {
    if (handshake) this.handlePortAHandshake();
    this.registers[MOS_6522_REGISTER.portA] = value;
    this.registers[MOS_6522_REGISTER.portAWithoutHandshake] = value;
    this.onPortAOutputChanged(this.portAOutputPins);
    this.onPortAAccess('write', handshake);
  }

  private writePortB(value: number, handshake: boolean): void {
    if (handshake) this.handlePortBHandshake();
    this.registers[MOS_6522_REGISTER.portB] = value;
    this.onPortBOutputChanged(this.portBOutputPins);
    this.onPortBAccess('write', handshake);
  }

  private handlePortAHandshake(): void {
    this.clearInterrupt(MOS_6522_INTERRUPT_BIT.ca1);
    if (!this.ca2InterruptIndependent()) this.clearInterrupt(MOS_6522_INTERRUPT_BIT.ca2);
    const mode = this.ca2ControlMode();
    if (
      mode === MOS_6522_PCR_CONTROL_MODE.handshakeOutput ||
      mode === MOS_6522_PCR_CONTROL_MODE.pulseOutput
    ) {
      this.setCa2Output(false);
      if (mode === MOS_6522_PCR_CONTROL_MODE.pulseOutput) this.ca2PulseCyclesRemaining = 1;
    }
  }

  private handlePortBHandshake(): void {
    this.clearInterrupt(MOS_6522_INTERRUPT_BIT.cb1);
    if (!this.cb2InterruptIndependent()) this.clearInterrupt(MOS_6522_INTERRUPT_BIT.cb2);
    const mode = this.cb2ControlMode();
    if (
      mode === MOS_6522_PCR_CONTROL_MODE.handshakeOutput ||
      mode === MOS_6522_PCR_CONTROL_MODE.pulseOutput
    ) {
      this.setCb2Output(false);
      if (mode === MOS_6522_PCR_CONTROL_MODE.pulseOutput) this.cb2PulseCyclesRemaining = 1;
    }
  }

  private writeTimer1LatchLow(value: number): void {
    this.timer1Latch = (this.timer1Latch & 0xff00) | value;
  }

  private startTimer1(highByte: number): void {
    this.timer1Latch = (this.timer1Latch & 0x00ff) | (highByte << 8);
    this.timer1Counter = this.timer1Latch;
    this.timer1Running = true;
    this.timer1IrqArmed = true;
    this.timer1ReloadPending = false;
    this.timer1StartDelay = 1;
    this.timer1PortB7High = false;
    this.clearInterrupt(MOS_6522_INTERRUPT_BIT.timer1);
    this.onPortBOutputChanged(this.portBOutputPins);
  }

  private startTimer2(highByte: number): void {
    this.timer2Counter = (highByte << 8) | this.timer2LowLatch;
    this.timer2Running = true;
    this.timer2IrqArmed = true;
    this.timer2StartDelay = 1;
    this.clearInterrupt(MOS_6522_INTERRUPT_BIT.timer2);
  }

  private tickTimer1(): void {
    if (!this.timer1Running) return;
    if (this.timer1StartDelay > 0) {
      this.timer1StartDelay -= 1;
      return;
    }
    if (this.timer1ReloadPending) {
      this.timer1Counter = this.timer1Latch;
      this.timer1ReloadPending = false;
      return;
    }
    if (this.timer1Counter !== 0) {
      this.timer1Counter = word(this.timer1Counter - 1);
      return;
    }

    this.timer1Counter = 0xffff;
    this.timer1ReloadPending = true;
    const timeoutArmed = this.timer1IrqArmed;
    if (timeoutArmed) this.raiseInterrupt(MOS_6522_INTERRUPT_BIT.timer1);
    const freeRunning = this.timer1FreeRunning();
    this.timer1IrqArmed = timeoutArmed && freeRunning;

    // PB7 在已装载的 T1 首次超时时翻转；单次模式随后仍会重装计数器，但不能再次翻转。
    // 这个“只响应已武装超时”的区别同时覆盖先装载 T1、后启用 PB7 的真实 VIA 顺序。
    if (timeoutArmed && this.timer1ControlsPortB7()) {
      this.timer1PortB7High = !this.timer1PortB7High;
      this.onPortBOutputChanged(this.portBOutputPins);
    }
  }

  private tickTimer2(): void {
    if (!this.timer2Running || this.timer2CountsPortB6()) return;
    if (this.timer2StartDelay > 0) {
      this.timer2StartDelay -= 1;
      return;
    }
    this.stepTimer2Counter();
  }

  private stepTimer2Counter(): void {
    if (!this.timer2Running) return;
    const previous = this.timer2Counter;
    this.timer2Counter = word(previous - 1);

    if ((previous & 0xff) === 0 && this.shiftUsesTimer2()) {
      this.timer2Counter = (this.timer2Counter & 0xff00) | this.timer2LowLatch;
      this.advanceShiftPhase(true);
    }
    if (previous === 0 && this.timer2IrqArmed) {
      this.timer2IrqArmed = false;
      this.raiseInterrupt(MOS_6522_INTERRUPT_BIT.timer2);
    }
  }

  private writeAuxiliaryControl(index: number, value: number): void {
    const previous = this.registers[index] ?? 0;
    const oldPortBOutput = this.portBOutputPins;
    this.registers[index] = value;

    if (
      (previous & MOS_6522_ACR_BIT.portAInputLatch) === 0 &&
      (value & MOS_6522_ACR_BIT.portAInputLatch) !== 0
    ) {
      this.latchedPortA = this.readPortAExternalInputs(this.portAOutputPins, this.portBOutputPins);
    }
    if (
      (previous & MOS_6522_ACR_BIT.portBInputLatch) === 0 &&
      (value & MOS_6522_ACR_BIT.portBInputLatch) !== 0
    ) {
      this.latchedPortB = this.readPortBExternalInputs(this.portAOutputPins, this.portBOutputPins);
    }
    if (
      (previous & MOS_6522_ACR_BIT.timer1PortB7Output) === 0 &&
      (value & MOS_6522_ACR_BIT.timer1PortB7Output) !== 0
    ) {
      this.timer1PortB7High = true;
    }
    if (this.shiftMode() === MOS_6522_SHIFT_MODE.disabled) {
      this.clearInterrupt(MOS_6522_INTERRUPT_BIT.shiftRegister);
      this.updateCb2FromPeripheralControl();
    }
    if (oldPortBOutput !== this.portBOutputPins) {
      this.onPortBOutputChanged(this.portBOutputPins);
    }
  }

  private writePeripheralControl(index: number, value: number): void {
    this.registers[index] = value;
    this.ca2PulseCyclesRemaining = 0;
    this.cb2PulseCyclesRemaining = 0;
    this.updateCa2FromPeripheralControl();
    this.updateCb2FromPeripheralControl();
  }

  private updateCa2FromPeripheralControl(): void {
    const mode = this.ca2ControlMode();
    this.setCa2Output(mode !== MOS_6522_PCR_CONTROL_MODE.lowOutput);
  }

  private updateCb2FromPeripheralControl(): void {
    if (this.shiftOutputsData()) return;
    const mode = this.cb2ControlMode();
    this.setCb2Output(mode !== MOS_6522_PCR_CONTROL_MODE.lowOutput);
  }

  private handleCa1Edge(): void {
    if (
      ((this.registers[MOS_6522_REGISTER.auxiliaryControl] ?? 0) &
        MOS_6522_ACR_BIT.portAInputLatch) !==
      0
    ) {
      this.latchedPortA = this.readPortAExternalInputs(this.portAOutputPins, this.portBOutputPins);
    }
    this.raiseInterrupt(MOS_6522_INTERRUPT_BIT.ca1);
    if (this.ca2ControlMode() === MOS_6522_PCR_CONTROL_MODE.handshakeOutput) {
      this.setCa2Output(true);
    }
  }

  private handleCb1Edge(): void {
    if (
      ((this.registers[MOS_6522_REGISTER.auxiliaryControl] ?? 0) &
        MOS_6522_ACR_BIT.portBInputLatch) !==
      0
    ) {
      this.latchedPortB = this.readPortBExternalInputs(this.portAOutputPins, this.portBOutputPins);
    }
    this.raiseInterrupt(MOS_6522_INTERRUPT_BIT.cb1);
    if (this.cb2ControlMode() === MOS_6522_PCR_CONTROL_MODE.handshakeOutput) {
      this.setCb2Output(true);
    }
  }

  private startShiftTransfer(): void {
    const mode = this.shiftMode();
    if (mode === MOS_6522_SHIFT_MODE.disabled) return;
    if (mode === MOS_6522_SHIFT_MODE.outputFreeRunningTimer2) {
      this.shiftPhase &= FINISHED_SHIFT_PHASE - 1;
    } else if (this.shiftPhase === FINISHED_SHIFT_PHASE) {
      this.shiftPhase = 0;
    }
    if (
      mode === MOS_6522_SHIFT_MODE.inputProcessorClock ||
      mode === MOS_6522_SHIFT_MODE.outputProcessorClock
    ) {
      this.shiftStartDelay = 1;
    }
  }

  private tickProcessorClockShift(): void {
    const mode = this.shiftMode();
    if (
      mode !== MOS_6522_SHIFT_MODE.inputProcessorClock &&
      mode !== MOS_6522_SHIFT_MODE.outputProcessorClock
    ) {
      return;
    }
    if (this.shiftPhase >= FINISHED_SHIFT_PHASE) return;
    if (this.shiftStartDelay > 0) {
      this.shiftStartDelay -= 1;
      return;
    }
    this.advanceShiftPhase(true);
  }

  private handleExternalShiftClock(high: boolean): void {
    const mode = this.shiftMode();
    if (
      mode !== MOS_6522_SHIFT_MODE.inputExternalClock &&
      mode !== MOS_6522_SHIFT_MODE.outputExternalClock
    ) {
      return;
    }
    if (this.shiftPhase >= FINISHED_SHIFT_PHASE) return;
    const expectedHigh = (this.shiftPhase & 1) !== 0;
    if (high === expectedHigh) this.advanceShiftPhase(false);
  }

  private advanceShiftPhase(driveClockOutput: boolean): void {
    if (this.shiftPhase >= FINISHED_SHIFT_PHASE) return;
    const output = this.shiftOutputsData();
    const evenPhase = (this.shiftPhase & 1) === 0;
    if (driveClockOutput) {
      this.onControlLineOutputChanged(MOS_6522_CONTROL_LINE.cb1, !evenPhase);
    }

    const registerIndex = MOS_6522_REGISTER.shiftRegister;
    const shiftRegister = this.registers[registerIndex] ?? 0;
    if (evenPhase && output) {
      const outputHigh = (shiftRegister & 0x80) !== 0;
      this.registers[registerIndex] = byte((shiftRegister << 1) | (outputHigh ? 1 : 0));
      this.setCb2Output(outputHigh);
    } else if (!evenPhase && !output) {
      this.registers[registerIndex] = byte((shiftRegister << 1) | (this.cb2InputHigh ? 1 : 0));
    }

    this.shiftPhase += 1;
    if (this.shiftPhase !== FINISHED_SHIFT_PHASE) return;
    if (this.shiftMode() === MOS_6522_SHIFT_MODE.outputFreeRunningTimer2) {
      this.shiftPhase = 0;
    } else {
      this.raiseInterrupt(MOS_6522_INTERRUPT_BIT.shiftRegister);
    }
  }

  private tickControlLinePulses(): void {
    if (this.ca2PulseCyclesRemaining > 0) {
      this.ca2PulseCyclesRemaining -= 1;
      if (this.ca2PulseCyclesRemaining === 0) this.setCa2Output(true);
    }
    if (this.cb2PulseCyclesRemaining > 0) {
      this.cb2PulseCyclesRemaining -= 1;
      if (this.cb2PulseCyclesRemaining === 0) this.setCb2Output(true);
    }
  }

  private setCa2Output(high: boolean): void {
    if (this.ca2OutputHigh === high) return;
    this.ca2OutputHigh = high;
    this.onControlLineOutputChanged(MOS_6522_CONTROL_LINE.ca2, high);
  }

  private setCb2Output(high: boolean): void {
    if (this.cb2OutputHigh === high) return;
    this.cb2OutputHigh = high;
    this.onControlLineOutputChanged(MOS_6522_CONTROL_LINE.cb2, high);
  }

  private raiseInterrupt(mask: number): void {
    this.interruptFlags |= mask & MOS_6522_INTERRUPT_BIT.sourceMask;
  }

  private clearInterrupt(mask: number): void {
    this.interruptFlags &= ~mask;
  }

  private timer1FreeRunning(): boolean {
    return (
      ((this.registers[MOS_6522_REGISTER.auxiliaryControl] ?? 0) &
        MOS_6522_ACR_BIT.timer1FreeRunning) !==
      0
    );
  }

  private timer1ControlsPortB7(): boolean {
    return (
      ((this.registers[MOS_6522_REGISTER.auxiliaryControl] ?? 0) &
        MOS_6522_ACR_BIT.timer1PortB7Output) !==
      0
    );
  }

  private timer2CountsPortB6(): boolean {
    return (
      ((this.registers[MOS_6522_REGISTER.auxiliaryControl] ?? 0) &
        MOS_6522_ACR_BIT.timer2CountPortB6) !==
      0
    );
  }

  private shiftMode(): Mos6522ShiftMode {
    return (((this.registers[MOS_6522_REGISTER.auxiliaryControl] ?? 0) &
      MOS_6522_ACR_BIT.shiftModeMask) >>
      2) as Mos6522ShiftMode;
  }

  private shiftOutputsData(): boolean {
    return this.shiftMode() >= MOS_6522_SHIFT_MODE.outputFreeRunningTimer2;
  }

  private shiftUsesTimer2(): boolean {
    const mode = this.shiftMode();
    return (
      mode === MOS_6522_SHIFT_MODE.inputTimer2 ||
      mode === MOS_6522_SHIFT_MODE.outputFreeRunningTimer2 ||
      mode === MOS_6522_SHIFT_MODE.outputTimer2
    );
  }

  private ca2ControlMode(): number {
    return ((this.registers[MOS_6522_REGISTER.peripheralControl] ?? 0) >>> 1) & 0x07;
  }

  private cb2ControlMode(): number {
    return ((this.registers[MOS_6522_REGISTER.peripheralControl] ?? 0) >>> 5) & 0x07;
  }

  private isCa2InputMode(): boolean {
    return this.ca2ControlMode() <= MOS_6522_PCR_CONTROL_MODE.inputPositiveEdgeIndependent;
  }

  private isCb2InputMode(): boolean {
    return this.cb2ControlMode() <= MOS_6522_PCR_CONTROL_MODE.inputPositiveEdgeIndependent;
  }

  private ca2InterruptIndependent(): boolean {
    const mode = this.ca2ControlMode();
    return (
      mode === MOS_6522_PCR_CONTROL_MODE.inputNegativeEdgeIndependent ||
      mode === MOS_6522_PCR_CONTROL_MODE.inputPositiveEdgeIndependent
    );
  }

  private cb2InterruptIndependent(): boolean {
    const mode = this.cb2ControlMode();
    return (
      mode === MOS_6522_PCR_CONTROL_MODE.inputNegativeEdgeIndependent ||
      mode === MOS_6522_PCR_CONTROL_MODE.inputPositiveEdgeIndependent
    );
  }

  private isCa1ActiveEdge(previous: boolean, high: boolean): boolean {
    const positive = ((this.registers[MOS_6522_REGISTER.peripheralControl] ?? 0) & 0x01) !== 0;
    return positive ? !previous && high : previous && !high;
  }

  private isCb1ActiveEdge(previous: boolean, high: boolean): boolean {
    const positive = ((this.registers[MOS_6522_REGISTER.peripheralControl] ?? 0) & 0x10) !== 0;
    return positive ? !previous && high : previous && !high;
  }

  private isControlModeActiveEdge(mode: number, previous: boolean, high: boolean): boolean {
    const positive =
      mode === MOS_6522_PCR_CONTROL_MODE.inputPositiveEdge ||
      mode === MOS_6522_PCR_CONTROL_MODE.inputPositiveEdgeIndependent;
    return positive ? !previous && high : previous && !high;
  }
}
