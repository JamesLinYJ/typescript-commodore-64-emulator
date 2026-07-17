import { describe, expect, it } from 'vitest';

import { CpuIrqLine } from '../../src/core/cpu/CpuIrqLine';

describe('CpuIrqLine', () => {
  it('tracks how long the physical IRQ input has been asserted', () => {
    const line = new CpuIrqLine();

    line.update(true, 10);

    expect(line.isPending(10)).toBe(true);
    expect(line.assertedCycles(10)).toBe(0);
    expect(line.assertedCycles(12)).toBe(2);
  });

  it('holds a deasserted IRQ pending for its three-cycle recognition window', () => {
    const line = new CpuIrqLine();
    line.update(true, 10);
    line.update(false, 12);

    expect(line.isPending(12)).toBe(true);
    expect(line.isPending(13)).toBe(true);
    expect(line.isPending(14)).toBe(true);

    line.update(false, 15);
    expect(line.isPending(15)).toBe(false);
    expect(line.assertedCycles(15)).toBe(0);
  });

  it('starts a fresh assertion interval when the line rises again', () => {
    const line = new CpuIrqLine();
    line.update(true, 10);
    line.update(false, 12);
    line.update(true, 13);

    expect(line.assertedCycles(13)).toBe(0);
    expect(line.assertedCycles(14)).toBe(1);
  });

  it('consumes a finished pulse after its first CPU-boundary poll', () => {
    const line = new CpuIrqLine();
    line.update(true, 10);
    line.update(false, 12);

    expect(line.isPending(12)).toBe(true);
    line.completeCpuBoundaryPoll();

    expect(line.isPending(13)).toBe(false);
    expect(line.assertedCycles(13)).toBe(0);
  });

  it('clears a latched pulse on acknowledgement but preserves an active level', () => {
    const pulse = new CpuIrqLine();
    pulse.update(true, 10);
    pulse.update(false, 12);
    pulse.acknowledge();
    expect(pulse.isPending(12)).toBe(false);

    const level = new CpuIrqLine();
    level.update(true, 10);
    level.acknowledge();
    expect(level.isPending(12)).toBe(true);
    expect(level.assertedCycles(12)).toBe(2);
  });
});
