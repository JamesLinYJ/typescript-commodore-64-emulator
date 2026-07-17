import { describe, expect, it } from 'vitest';

import { CpuInterruptTiming } from '../../src/core/cpu/CpuInterruptTiming';

const RETURN_FROM_INTERRUPT_OPCODE = 0x40;
const CLEAR_INTERRUPT_DISABLE_OPCODE = 0x58;
const BRANCH_NOT_EQUAL_OPCODE = 0xd0;
const SET_INTERRUPT_DISABLE_OPCODE = 0x78;
const NO_OPERATION_OPCODE = 0xea;
const BREAK_OPCODE = 0x00;

function completeInstruction(
  timing: CpuInterruptTiming,
  opcode: number,
  interruptMaskedBefore: boolean,
  interruptMaskedAfter = interruptMaskedBefore,
): void {
  timing.beginInstruction();
  timing.completeInstruction({
    interruptMaskedAfter,
    interruptMaskedBefore,
    opcode,
  });
}

describe('CpuInterruptTiming', () => {
  it('accepts an unmasked IRQ after the normal two-cycle recognition delay', () => {
    const timing = new CpuInterruptTiming();
    completeInstruction(timing, NO_OPERATION_OPCODE, false);

    expect(timing.canAcceptMaskableInterrupt(1, false)).toBe(false);
    expect(timing.canAcceptMaskableInterrupt(2, false)).toBe(true);
  });

  it('delays an IRQ for one instruction after CLI enables it', () => {
    const timing = new CpuInterruptTiming();
    completeInstruction(timing, CLEAR_INTERRUPT_DISABLE_OPCODE, true, false);

    expect(timing.canAcceptMaskableInterrupt(2, false)).toBe(false);

    completeInstruction(timing, NO_OPERATION_OPCODE, false);
    expect(timing.canAcceptMaskableInterrupt(2, false)).toBe(true);
  });

  it('accepts an IRQ sampled before SEI masks later interrupts', () => {
    const timing = new CpuInterruptTiming();
    completeInstruction(timing, SET_INTERRUPT_DISABLE_OPCODE, false, true);

    expect(timing.canAcceptMaskableInterrupt(2, true)).toBe(true);
  });

  it('uses the status restored by RTI immediately', () => {
    const timing = new CpuInterruptTiming();
    completeInstruction(timing, RETURN_FROM_INTERRUPT_OPCODE, true, false);

    expect(timing.canAcceptMaskableInterrupt(2, false)).toBe(true);
  });

  it('requires three asserted cycles after a taken non-crossing branch', () => {
    const timing = new CpuInterruptTiming();
    timing.beginInstruction();
    timing.delayInterruptForTakenBranch();
    timing.completeInstruction({
      interruptMaskedAfter: false,
      interruptMaskedBefore: false,
      opcode: BRANCH_NOT_EQUAL_OPCODE,
    });

    expect(timing.canAcceptMaskableInterrupt(2, false)).toBe(false);
    expect(timing.canAcceptMaskableInterrupt(3, false)).toBe(true);
  });

  it('applies the recognition delay to NMI without consulting the I flag', () => {
    const timing = new CpuInterruptTiming();
    completeInstruction(timing, NO_OPERATION_OPCODE, true);

    expect(timing.canAcceptNonMaskableInterrupt(1)).toBe(false);
    expect(timing.canAcceptNonMaskableInterrupt(2)).toBe(true);
  });

  it('delays NMI after a taken branch and defers it across BRK', () => {
    const timing = new CpuInterruptTiming();
    timing.beginInstruction();
    timing.delayInterruptForTakenBranch();
    timing.completeInstruction({
      interruptMaskedAfter: false,
      interruptMaskedBefore: false,
      opcode: BRANCH_NOT_EQUAL_OPCODE,
    });
    expect(timing.canAcceptNonMaskableInterrupt(2)).toBe(false);
    expect(timing.canAcceptNonMaskableInterrupt(3)).toBe(true);

    completeInstruction(timing, BREAK_OPCODE, false, true);
    expect(timing.canAcceptNonMaskableInterrupt(10)).toBe(false);
  });
});
