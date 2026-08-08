// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6526 CIA 核心测试
//
//   文件:       Mos6526.test.ts
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
import { Mos6526 } from '../../src/devices/Mos6526';
import { MOS_6526_MODEL } from '../../src/devices/Mos6526Model';

function writeTimerA(cia: Mos6526, value: number): void {
  cia.write(CIA_REGISTER.timerALow, value & 0xff);
  cia.write(CIA_REGISTER.timerAHigh, value >> 8);
}

function writeTimerB(cia: Mos6526, value: number): void {
  cia.write(CIA_REGISTER.timerBLow, value & 0xff);
  cia.write(CIA_REGISTER.timerBHigh, value >> 8);
}

class ObservedMos6526 extends Mos6526 {
  portBTransitions: number[] | undefined;
  serialTransitions: [clockHigh: boolean, dataHigh: boolean][] | undefined;

  constructor(name: string, model: (typeof MOS_6526_MODEL)[keyof typeof MOS_6526_MODEL]) {
    super(name, { model });
    this.portBTransitions = [];
    this.serialTransitions = [];
  }

  clearTransitions(): void {
    this.portBTransitions?.splice(0);
    this.serialTransitions?.splice(0);
  }

  protected override onPortBOutputChanged(pins: number): void {
    this.portBTransitions?.push(pins);
  }

  protected override onSerialOutputChanged(clockHigh: boolean, dataHigh: boolean): void {
    this.serialTransitions?.push([clockHigh, dataHigh]);
  }
}

function configureObservedOutputs(cia: ObservedMos6526): void {
  cia.write(CIA_REGISTER.portB, 0xff);
  cia.write(CIA_REGISTER.dataDirectionB, 0xff);
  writeTimerA(cia, 1);
  cia.write(CIA_REGISTER.serialData, 0xa5);
  cia.write(
    CIA_REGISTER.interruptControl,
    CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.timerA | CIA_INTERRUPT_BIT.serial,
  );
  cia.write(
    CIA_REGISTER.timerAControl,
    CIA_TIMER_CONTROL_BIT.start |
      CIA_TIMER_CONTROL_BIT.portBOutput |
      CIA_TIMER_CONTROL_BIT.forceLoad |
      CIA_TIMER_CONTROL_BIT.serialOutputMode,
  );
  cia.clearTransitions();
}

describe('Mos6526', () => {
  it('combines output latches and data-direction registers at the port pins', () => {
    const cia = new Mos6526();

    cia.write(CIA_REGISTER.portA, 0x05);
    cia.write(CIA_REGISTER.dataDirectionA, 0x0f);

    expect(cia.portAOutputPins).toBe(0xf5);
    expect(cia.read(CIA_REGISTER.portA)).toBe(0xf5);
  });

  it('pulses the low-active PC output for one cycle after Port B access', () => {
    const cia = new Mos6526();
    expect(cia.portControlOutputHigh).toBe(true);

    cia.read(CIA_REGISTER.portB);
    expect(cia.portControlOutputHigh).toBe(false);
    cia.tick(1);
    expect(cia.portControlOutputHigh).toBe(true);

    cia.write(CIA_REGISTER.portB, 0x55);
    expect(cia.portControlOutputHigh).toBe(false);
    cia.tick(1);
    expect(cia.portControlOutputHigh).toBe(true);
  });

  it('reloads a continuous Timer A and implements ICR read-to-clear semantics', () => {
    const cia = new Mos6526();
    writeTimerA(cia, 3);
    cia.write(
      CIA_REGISTER.interruptControl,
      CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.timerA,
    );
    cia.write(
      CIA_REGISTER.timerAControl,
      CIA_TIMER_CONTROL_BIT.start | CIA_TIMER_CONTROL_BIT.forceLoad,
    );

    expect(cia.tick(4)).toBe(false);
    expect(cia.read(CIA_REGISTER.timerALow)).toBe(2);
    expect(cia.tick(2)).toBe(false);
    expect(cia.read(CIA_REGISTER.timerALow)).toBe(3);
    expect(cia.tick(1)).toBe(true);
    expect(cia.read(CIA_REGISTER.interruptControl)).toBe(
      CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.timerA,
    );
    expect(cia.interruptPending).toBe(false);
  });

  it('stops a one-shot timer after its first underflow', () => {
    const cia = new Mos6526();
    writeTimerA(cia, 1);
    cia.write(
      CIA_REGISTER.timerAControl,
      CIA_TIMER_CONTROL_BIT.start | CIA_TIMER_CONTROL_BIT.oneShot | CIA_TIMER_CONTROL_BIT.forceLoad,
    );

    cia.tick(4);

    expect(cia.read(CIA_REGISTER.timerAControl) & CIA_TIMER_CONTROL_BIT.start).toBe(0);
    expect(cia.read(CIA_REGISTER.timerALow)).toBe(1);
  });

  it('can cascade Timer B from Timer A underflows', () => {
    const cia = new Mos6526();
    writeTimerA(cia, 1);
    writeTimerB(cia, 2);
    cia.write(
      CIA_REGISTER.timerAControl,
      CIA_TIMER_CONTROL_BIT.start | CIA_TIMER_CONTROL_BIT.forceLoad,
    );
    cia.write(
      CIA_REGISTER.timerBControl,
      CIA_TIMER_CONTROL_BIT.start | CIA_TIMER_CONTROL_BIT.forceLoad | (2 << 5),
    );

    cia.tick(8);

    expect(cia.read(CIA_REGISTER.interruptControl)).toBe(
      CIA_INTERRUPT_BIT.timerA | CIA_INTERRUPT_BIT.timerB,
    );
  });

  it('asserts an already-latched interrupt when its mask is enabled later', () => {
    const cia = new Mos6526();
    writeTimerA(cia, 1);
    cia.write(
      CIA_REGISTER.timerAControl,
      CIA_TIMER_CONTROL_BIT.start | CIA_TIMER_CONTROL_BIT.forceLoad,
    );
    expect(cia.tick(4)).toBe(false);

    cia.write(
      CIA_REGISTER.interruptControl,
      CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.timerA,
    );

    expect(cia.interruptPending).toBe(false);
    expect(cia.tick(2)).toBe(true);
    expect(cia.read(CIA_REGISTER.interruptControl)).toBe(
      CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.timerA,
    );
  });

  it('models the one-cycle interrupt latency difference between 6526 and 6526A', () => {
    const original = new Mos6526('original', { model: MOS_6526_MODEL.original });
    const revised = new Mos6526('revised', { model: MOS_6526_MODEL.revised });

    for (const cia of [original, revised]) {
      writeTimerA(cia, 1);
      cia.write(
        CIA_REGISTER.interruptControl,
        CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.timerA,
      );
      cia.write(
        CIA_REGISTER.timerAControl,
        CIA_TIMER_CONTROL_BIT.start | CIA_TIMER_CONTROL_BIT.forceLoad,
      );
    }

    expect(original.tick(4)).toBe(false);
    expect(revised.tick(4)).toBe(true);
    expect(original.tick(1)).toBe(true);
  });

  it('delays a 6526A interrupt when underflow follows an ICR read immediately', () => {
    const cia = new Mos6526('revised', { model: MOS_6526_MODEL.revised });
    writeTimerA(cia, 1);
    cia.write(
      CIA_REGISTER.interruptControl,
      CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.timerA,
    );
    cia.write(
      CIA_REGISTER.timerAControl,
      CIA_TIMER_CONTROL_BIT.start | CIA_TIMER_CONTROL_BIT.forceLoad,
    );

    expect(cia.tick(3)).toBe(false);
    expect(cia.read(CIA_REGISTER.interruptControl)).toBe(0);
    expect(cia.tick(1)).toBe(false);
    expect(cia.tick(1)).toBe(true);
  });

  it('advances the BCD 12-hour TOD clock and toggles PM at eleven fifty-nine', () => {
    const cia = new Mos6526();
    cia.write(CIA_REGISTER.timerAControl, CIA_TIMER_CONTROL_BIT.timeOfDay50Hz);
    cia.write(CIA_REGISTER.timeOfDayHours, 0x11);
    cia.write(CIA_REGISTER.timeOfDayMinutes, 0x59);
    cia.write(CIA_REGISTER.timeOfDaySeconds, 0x59);
    cia.write(CIA_REGISTER.timeOfDayTenths, 0x09);

    cia.tickTimeOfDayInput(5);

    expect(cia.read(CIA_REGISTER.timeOfDayHours)).toBe(0x92);
    expect(cia.read(CIA_REGISTER.timeOfDayMinutes)).toBe(0x00);
    expect(cia.read(CIA_REGISTER.timeOfDaySeconds)).toBe(0x00);
    expect(cia.read(CIA_REGISTER.timeOfDayTenths)).toBe(0x00);
  });

  it('keeps timer, interrupt, and TOD phase identical through the single-cycle fast path', () => {
    const timing = { processorClockHz: 10, timeOfDayInputHz: 2 } as const;
    const batched = new Mos6526('batched', { timing });
    const singleCycle = new Mos6526('single-cycle', { timing });

    for (const cia of [batched, singleCycle]) {
      writeTimerA(cia, 3);
      cia.write(
        CIA_REGISTER.interruptControl,
        CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.timerA,
      );
      cia.write(
        CIA_REGISTER.timerAControl,
        CIA_TIMER_CONTROL_BIT.start | CIA_TIMER_CONTROL_BIT.forceLoad,
      );
    }

    const batchedInterrupt = batched.tick(30);
    let singleCycleInterrupt = false;
    for (let cycle = 0; cycle < 30; cycle += 1) {
      singleCycleInterrupt = singleCycle.clockCycle();
    }

    expect(singleCycleInterrupt).toBe(batchedInterrupt);
    expect(singleCycle.read(CIA_REGISTER.timerALow)).toBe(batched.read(CIA_REGISTER.timerALow));
    expect(singleCycle.read(CIA_REGISTER.timeOfDayTenths)).toBe(
      batched.read(CIA_REGISTER.timeOfDayTenths),
    );
    expect(singleCycle.read(CIA_REGISTER.interruptControl)).toBe(
      batched.read(CIA_REGISTER.interruptControl),
    );
  });

  it('keeps PB6 and serial pin transitions identical through the single-cycle fast path', () => {
    for (const model of [MOS_6526_MODEL.original, MOS_6526_MODEL.revised]) {
      const batched = new ObservedMos6526('batched outputs', model);
      const singleCycle = new ObservedMos6526('single-cycle outputs', model);
      configureObservedOutputs(batched);
      configureObservedOutputs(singleCycle);

      for (let cycle = 0; cycle < 48; cycle += 1) {
        expect(singleCycle.clockCycle()).toBe(batched.tick(1));
        expect(singleCycle.portBOutputPins).toBe(batched.portBOutputPins);
        expect(singleCycle.serialClockOutputHigh).toBe(batched.serialClockOutputHigh);
        expect(singleCycle.serialDataOutputHigh).toBe(batched.serialDataOutputHigh);
        expect(singleCycle.read(CIA_REGISTER.timerALow)).toBe(batched.read(CIA_REGISTER.timerALow));
      }

      expect(singleCycle.portBTransitions).toEqual(batched.portBTransitions);
      expect(singleCycle.serialTransitions).toEqual(batched.serialTransitions);
      expect(singleCycle.read(CIA_REGISTER.interruptControl)).toBe(
        batched.read(CIA_REGISTER.interruptControl),
      );
    }
  });

  it('preserves invalid BCD bit patterns written to TOD registers', () => {
    const cia = new Mos6526();

    cia.write(CIA_REGISTER.timeOfDayHours, 0x0d);
    cia.write(CIA_REGISTER.timeOfDayMinutes, 0x7a);
    cia.write(CIA_REGISTER.timeOfDaySeconds, 0x6b);
    cia.write(CIA_REGISTER.timeOfDayTenths, 0x0f);

    expect(cia.read(CIA_REGISTER.timeOfDayHours)).toBe(0x0d);
    expect(cia.read(CIA_REGISTER.timeOfDayMinutes)).toBe(0x7a);
    expect(cia.read(CIA_REGISTER.timeOfDaySeconds)).toBe(0x6b);
    expect(cia.read(CIA_REGISTER.timeOfDayTenths)).toBe(0x0f);
  });

  it('raises the alarm and FLAG interrupt sources', () => {
    const cia = new Mos6526();
    cia.write(CIA_REGISTER.timerAControl, CIA_TIMER_CONTROL_BIT.timeOfDay50Hz);
    cia.write(CIA_REGISTER.timerBControl, CIA_TIMER_CONTROL_BIT.alarmWrite);
    cia.write(CIA_REGISTER.timeOfDayHours, 0x01);
    cia.write(CIA_REGISTER.timeOfDayMinutes, 0x00);
    cia.write(CIA_REGISTER.timeOfDaySeconds, 0x00);
    cia.write(CIA_REGISTER.timeOfDayTenths, 0x01);
    cia.write(CIA_REGISTER.timerBControl, 0);
    cia.write(CIA_REGISTER.timeOfDayHours, 0x01);
    cia.write(CIA_REGISTER.timeOfDayMinutes, 0x00);
    cia.write(CIA_REGISTER.timeOfDaySeconds, 0x00);
    cia.write(CIA_REGISTER.timeOfDayTenths, 0x00);
    cia.tickTimeOfDayInput(5);
    cia.pulseFlag();

    expect(cia.read(CIA_REGISTER.interruptControl)).toBe(
      CIA_INTERRUPT_BIT.alarm | CIA_INTERRUPT_BIT.flag,
    );
  });

  it('detects only falling FLAG pin edges while a low level is held', () => {
    const cia = new Mos6526();

    cia.setFlagPinHigh(false);
    expect(cia.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(
      CIA_INTERRUPT_BIT.flag,
    );

    cia.setFlagPinHigh(false);
    expect(cia.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(0);

    cia.setFlagPinHigh(true);
    cia.setFlagPinHigh(false);
    expect(cia.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(
      CIA_INTERRUPT_BIT.flag,
    );
  });
});
