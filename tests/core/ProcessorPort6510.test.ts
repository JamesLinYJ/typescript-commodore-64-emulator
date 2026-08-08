import { describe, expect, it } from 'vitest';

import { ProcessorPort6510 } from '../../src/core/memory/ProcessorPort6510';

describe('ProcessorPort6510', () => {
  it('powers up with the documented C64 pull-ups and zeroed latches', () => {
    const port = new ProcessorPort6510();

    expect(port.directionRegister).toBe(0x00);
    expect(port.outputLatch).toBe(0x00);
    expect(port.dataRegister).toBe(0x17);
  });

  it('combines the output latch with external pins according to the DDR', () => {
    const port = new ProcessorPort6510();
    port.writeDirection(0x0f);
    port.writeData(0x05);
    port.setInputPins(0x30, 0x20);

    expect(port.directionRegister).toBe(0x0f);
    expect(port.outputLatch).toBe(0x05);
    expect(port.dataRegister).toBe(0x25);
  });

  it('holds floating bits 6 and 7 after output-to-input transitions, then discharges them', () => {
    const port = new ProcessorPort6510({ floatingPinFallOffCycles: 5 });
    port.writeDirection(0xc0);
    port.writeData(0xc0);
    port.writeDirection(0x00);

    expect(port.dataRegister & 0xc0).toBe(0xc0);
    port.writeData(0x00);
    expect(port.dataRegister & 0xc0).toBe(0xc0);

    port.tick(4);
    expect(port.dataRegister & 0xc0).toBe(0xc0);
    port.tick(1);
    expect(port.dataRegister & 0xc0).toBe(0x00);
  });

  it('does not charge floating inputs when data is written while they are inputs', () => {
    const port = new ProcessorPort6510();
    port.writeDirection(0x00);
    port.writeData(0xc0);

    expect(port.dataRegister & 0xc0).toBe(0x00);
  });

  it('uses pulled-up input pins when deriving the PLA banking lines', () => {
    const port = new ProcessorPort6510();
    port.writeDirection(0x00);
    port.writeData(0x00);

    expect(port.bankingConfiguration).toBe(0x07);

    port.setInputPins(0x07, 0x02);
    expect(port.bankingConfiguration).toBe(0x02);
  });

  it('keeps the single-cycle hot path exactly equivalent to tick(1)', () => {
    const batched = new ProcessorPort6510({ floatingPinFallOffCycles: 5 });
    const singleCycle = new ProcessorPort6510({ floatingPinFallOffCycles: 5 });
    for (const port of [batched, singleCycle]) {
      port.writeDirection(0xc0);
      port.writeData(0xc0);
      port.writeDirection(0x00);
      port.writeData(0x00);
    }

    for (let cycle = 0; cycle < 8; cycle += 1) {
      batched.tick(1);
      singleCycle.clockCycle();
      expect(singleCycle.directionRegister).toBe(batched.directionRegister);
      expect(singleCycle.outputLatch).toBe(batched.outputLatch);
      expect(singleCycle.dataRegister).toBe(batched.dataRegister);
      expect(singleCycle.bankingConfiguration).toBe(batched.bankingConfiguration);
    }
  });
});
