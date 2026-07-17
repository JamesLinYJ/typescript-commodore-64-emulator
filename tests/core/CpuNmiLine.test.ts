import { describe, expect, it } from 'vitest';

import { CpuNmiLine } from '../../src/core/cpu/CpuNmiLine';

describe('CpuNmiLine', () => {
  it('latches a rising assertion edge until the CPU acknowledges it', () => {
    const line = new CpuNmiLine();
    line.update(true, 10);
    line.update(false, 11);

    expect(line.isPending).toBe(true);
    expect(line.elapsedCycles(12)).toBe(2);

    line.acknowledge();
    expect(line.isPending).toBe(false);
  });

  it('does not retrigger while an acknowledged physical level remains asserted', () => {
    const line = new CpuNmiLine();
    line.update(true, 10);
    line.acknowledge();
    line.update(true, 11);

    expect(line.isPending).toBe(false);

    line.update(false, 12);
    line.update(true, 13);
    expect(line.isPending).toBe(true);
    expect(line.elapsedCycles(13)).toBe(0);
  });

  it('keeps the first edge time while an NMI is already pending', () => {
    const line = new CpuNmiLine();
    line.update(true, 10);
    line.update(false, 11);
    line.update(true, 12);

    expect(line.elapsedCycles(13)).toBe(3);
  });
});
