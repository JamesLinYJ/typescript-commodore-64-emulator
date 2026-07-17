// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6522 VIA 测试
//
//   文件:       Mos6522.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { Mos6522 } from '../../src/devices/Mos6522';
import {
  MOS_6522_ACR_BIT,
  MOS_6522_CONTROL_LINE,
  MOS_6522_INTERRUPT_BIT,
  MOS_6522_PCR_CONTROL_MODE,
  MOS_6522_REGISTER,
  MOS_6522_SHIFT_MODE,
  type Mos6522ControlLine,
} from '../../src/devices/Mos6522Registers';

class TestMos6522 extends Mos6522 {
  externalPortA = 0xff;
  externalPortB = 0xff;
  readonly controlOutputEvents: { readonly high: boolean; readonly line: Mos6522ControlLine }[] =
    [];
  readonly portAOutputEvents: number[] = [];
  readonly portBOutputEvents: number[] = [];

  constructor() {
    super('test VIA');
  }

  protected override readPortAExternalInputs(): number {
    return this.externalPortA;
  }

  protected override readPortBExternalInputs(): number {
    return this.externalPortB;
  }

  protected override onPortAOutputChanged(pins: number): void {
    this.portAOutputEvents?.push(pins);
  }

  protected override onPortBOutputChanged(pins: number): void {
    this.portBOutputEvents?.push(pins);
  }

  protected override onControlLineOutputChanged(line: Mos6522ControlLine, high: boolean): void {
    this.controlOutputEvents?.push({ high, line });
  }
}

describe('Mos6522', () => {
  it('combines output latches, direction registers, and external input pins', () => {
    const via = new TestMos6522();
    via.externalPortA = 0xa0;
    via.write(MOS_6522_REGISTER.dataDirectionA, 0x0f);
    via.write(MOS_6522_REGISTER.portA, 0x05);

    expect(via.portAOutputPins).toBe(0xf5);
    expect(via.read(MOS_6522_REGISTER.portA)).toBe(0xa5);
    expect(via.portAOutputEvents.at(-1)).toBe(0xf5);
  });

  it('raises Timer 1 IRQ after the observable N, zero, and underflow sequence', () => {
    const via = new TestMos6522();
    via.write(
      MOS_6522_REGISTER.interruptEnable,
      MOS_6522_INTERRUPT_BIT.any | MOS_6522_INTERRUPT_BIT.timer1,
    );
    via.write(MOS_6522_REGISTER.timer1CounterLow, 0x02);
    via.write(MOS_6522_REGISTER.timer1CounterHigh, 0x00);

    via.tick(1);
    expect(via.read(MOS_6522_REGISTER.timer1CounterHigh)).toBe(0x00);
    expect(via.read(MOS_6522_REGISTER.timer1CounterLow)).toBe(0x02);
    via.tick(2);
    expect(via.interruptPending).toBe(false);
    via.tick(1);

    expect(via.interruptPending).toBe(true);
    expect(via.read(MOS_6522_REGISTER.interruptFlags)).toBe(
      MOS_6522_INTERRUPT_BIT.any | MOS_6522_INTERRUPT_BIT.timer1,
    );
    via.read(MOS_6522_REGISTER.timer1CounterLow);
    expect(via.interruptPending).toBe(false);
  });

  it('reloads free-running Timer 1 and toggles its PB7 output', () => {
    const via = new TestMos6522();
    via.write(MOS_6522_REGISTER.dataDirectionB, 0x80);
    via.write(
      MOS_6522_REGISTER.auxiliaryControl,
      MOS_6522_ACR_BIT.timer1FreeRunning | MOS_6522_ACR_BIT.timer1PortB7Output,
    );
    via.write(MOS_6522_REGISTER.timer1CounterLow, 0x00);
    via.write(MOS_6522_REGISTER.timer1CounterHigh, 0x00);
    expect(via.portBOutputPins & 0x80).toBe(0x00);

    via.tick(2);
    expect(via.portBOutputPins & 0x80).toBe(0x80);
    via.write(MOS_6522_REGISTER.interruptFlags, MOS_6522_INTERRUPT_BIT.timer1);
    via.tick(2);
    expect(via.portBOutputPins & 0x80).toBe(0x00);
    expect(via.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.timer1).toBe(
      MOS_6522_INTERRUPT_BIT.timer1,
    );
  });

  it('toggles one-shot PB7 once when output is enabled after Timer 1 is loaded', () => {
    const via = new TestMos6522();
    via.write(MOS_6522_REGISTER.dataDirectionB, 0x80);
    via.write(MOS_6522_REGISTER.portB, 0x00);
    via.write(MOS_6522_REGISTER.timer1CounterLow, 0x00);
    via.write(MOS_6522_REGISTER.timer1CounterHigh, 0x00);
    via.write(MOS_6522_REGISTER.auxiliaryControl, MOS_6522_ACR_BIT.timer1PortB7Output);
    expect(via.portBOutputPins & 0x80).toBe(0x80);

    via.tick(2);
    expect(via.portBOutputPins & 0x80).toBe(0x00);
    via.tick(8);
    expect(via.portBOutputPins & 0x80).toBe(0x00);

    via.write(
      MOS_6522_REGISTER.auxiliaryControl,
      MOS_6522_ACR_BIT.timer1FreeRunning | MOS_6522_ACR_BIT.timer1PortB7Output,
    );
    via.tick(8);
    expect(via.portBOutputPins & 0x80).toBe(0x00);
  });

  it('supports Timer 2 processor-clock and PB6 falling-edge modes', () => {
    const timerMode = new TestMos6522();
    timerMode.write(MOS_6522_REGISTER.timer2CounterLow, 0x01);
    timerMode.write(MOS_6522_REGISTER.timer2CounterHigh, 0x00);
    timerMode.tick(3);
    expect(timerMode.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.timer2).toBe(
      MOS_6522_INTERRUPT_BIT.timer2,
    );

    const pulseMode = new TestMos6522();
    pulseMode.write(MOS_6522_REGISTER.auxiliaryControl, MOS_6522_ACR_BIT.timer2CountPortB6);
    pulseMode.write(MOS_6522_REGISTER.timer2CounterLow, 0x01);
    pulseMode.write(MOS_6522_REGISTER.timer2CounterHigh, 0x00);
    pulseMode.tick(100);
    expect(pulseMode.interruptPending).toBe(false);
    pulseMode.signalPortB6(false);
    pulseMode.signalPortB6(true);
    pulseMode.signalPortB6(false);
    expect(pulseMode.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.timer2).toBe(
      MOS_6522_INTERRUPT_BIT.timer2,
    );
  });

  it('latches Port A on the selected CA1 edge and preserves flags on no-handshake reads', () => {
    const via = new TestMos6522();
    via.externalPortA = 0xaa;
    via.write(MOS_6522_REGISTER.auxiliaryControl, MOS_6522_ACR_BIT.portAInputLatch);
    via.signalControlLine(MOS_6522_CONTROL_LINE.ca1, false);
    via.externalPortA = 0x55;

    expect(via.read(MOS_6522_REGISTER.portAWithoutHandshake)).toBe(0xaa);
    expect(via.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.ca1).toBe(
      MOS_6522_INTERRUPT_BIT.ca1,
    );
    expect(via.read(MOS_6522_REGISTER.portA)).toBe(0xaa);
    expect(via.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.ca1).toBe(0);
  });

  it('keeps independent CA2 interrupts set when Port A is accessed', () => {
    const via = new TestMos6522();
    via.write(
      MOS_6522_REGISTER.peripheralControl,
      MOS_6522_PCR_CONTROL_MODE.inputNegativeEdgeIndependent << 1,
    );
    via.signalControlLine(MOS_6522_CONTROL_LINE.ca2, false);
    via.read(MOS_6522_REGISTER.portA);

    expect(via.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.ca2).toBe(
      MOS_6522_INTERRUPT_BIT.ca2,
    );
    via.write(MOS_6522_REGISTER.interruptFlags, MOS_6522_INTERRUPT_BIT.ca2);
    expect(via.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.ca2).toBe(0);
  });

  it('drives CA2 handshake and one-cycle pulse modes with explicit line transitions', () => {
    const via = new TestMos6522();
    via.controlOutputEvents.length = 0;
    via.write(MOS_6522_REGISTER.peripheralControl, MOS_6522_PCR_CONTROL_MODE.handshakeOutput << 1);
    via.write(MOS_6522_REGISTER.portA, 0x00);
    expect(via.controlOutputEvents.at(-1)).toEqual({
      high: false,
      line: MOS_6522_CONTROL_LINE.ca2,
    });
    via.signalControlLine(MOS_6522_CONTROL_LINE.ca1, false);
    expect(via.controlOutputEvents.at(-1)).toEqual({
      high: true,
      line: MOS_6522_CONTROL_LINE.ca2,
    });

    via.write(MOS_6522_REGISTER.peripheralControl, MOS_6522_PCR_CONTROL_MODE.pulseOutput << 1);
    via.write(MOS_6522_REGISTER.portA, 0x00);
    expect(via.controlOutputEvents.at(-1)?.high).toBe(false);
    via.tick(1);
    expect(via.controlOutputEvents.at(-1)?.high).toBe(true);
  });

  it('shifts eight output bits under the processor clock and raises the SR interrupt', () => {
    const via = new TestMos6522();
    via.controlOutputEvents.length = 0;
    via.write(MOS_6522_REGISTER.auxiliaryControl, MOS_6522_SHIFT_MODE.outputProcessorClock << 2);
    via.write(MOS_6522_REGISTER.shiftRegister, 0xa5);
    via.tick(17);

    expect(via.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.shiftRegister).toBe(
      MOS_6522_INTERRUPT_BIT.shiftRegister,
    );
    expect(via.read(MOS_6522_REGISTER.shiftRegister)).toBe(0xa5);
    expect(
      via.controlOutputEvents.filter((event) => event.line === MOS_6522_CONTROL_LINE.cb1),
    ).toHaveLength(16);
  });

  it('sets and clears individual interrupt enables while reporting bit 7 on reads', () => {
    const via = new TestMos6522();
    via.write(
      MOS_6522_REGISTER.interruptEnable,
      MOS_6522_INTERRUPT_BIT.any | MOS_6522_INTERRUPT_BIT.timer1 | MOS_6522_INTERRUPT_BIT.timer2,
    );
    expect(via.read(MOS_6522_REGISTER.interruptEnable)).toBe(
      MOS_6522_INTERRUPT_BIT.any | MOS_6522_INTERRUPT_BIT.timer1 | MOS_6522_INTERRUPT_BIT.timer2,
    );

    via.write(MOS_6522_REGISTER.interruptEnable, MOS_6522_INTERRUPT_BIT.timer2);
    expect(via.read(MOS_6522_REGISTER.interruptEnable)).toBe(
      MOS_6522_INTERRUPT_BIT.any | MOS_6522_INTERRUPT_BIT.timer1,
    );
  });
});
