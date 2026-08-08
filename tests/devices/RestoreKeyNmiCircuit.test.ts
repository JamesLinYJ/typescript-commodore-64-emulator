// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - RESTORE 键 NMI 单稳态电路测试
//
//   文件:       RestoreKeyNmiCircuit.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  RESTORE_NMI_PULSE_CYCLES,
  RestoreKeyNmiCircuit,
} from '../../src/devices/RestoreKeyNmiCircuit';

describe('RestoreKeyNmiCircuit', () => {
  it('converts a press edge into one fixed-width NMI pulse', () => {
    const circuit = new RestoreKeyNmiCircuit();

    circuit.setRestoreKeyPressed(true);
    expect(circuit.nmiAsserted).toBe(true);

    circuit.tick(RESTORE_NMI_PULSE_CYCLES - 1);
    expect(circuit.nmiAsserted).toBe(true);

    circuit.tick(1);
    expect(circuit.nmiAsserted).toBe(false);
  });

  it('does not shorten the pulse on release or retrigger while held', () => {
    const circuit = new RestoreKeyNmiCircuit();

    circuit.setRestoreKeyPressed(true);
    circuit.tick(4);
    circuit.setRestoreKeyPressed(false);
    circuit.tick(RESTORE_NMI_PULSE_CYCLES - 5);
    expect(circuit.nmiAsserted).toBe(true);

    circuit.tick(1);
    expect(circuit.nmiAsserted).toBe(false);

    circuit.setRestoreKeyPressed(true);
    circuit.tick(RESTORE_NMI_PULSE_CYCLES);
    circuit.setRestoreKeyPressed(true);
    expect(circuit.nmiAsserted).toBe(false);

    circuit.setRestoreKeyPressed(false);
    circuit.setRestoreKeyPressed(true);
    expect(circuit.nmiAsserted).toBe(true);
  });

  it('returns both the key latch and pulse output to idle on reset', () => {
    const circuit = new RestoreKeyNmiCircuit();
    circuit.setRestoreKeyPressed(true);

    circuit.reset();
    expect(circuit.nmiAsserted).toBe(false);

    circuit.setRestoreKeyPressed(true);
    expect(circuit.nmiAsserted).toBe(true);
  });

  it('keeps the single-cycle hot path exactly equivalent to tick(1)', () => {
    const batched = new RestoreKeyNmiCircuit();
    const singleCycle = new RestoreKeyNmiCircuit();
    batched.setRestoreKeyPressed(true);
    singleCycle.setRestoreKeyPressed(true);

    for (let cycle = 0; cycle < RESTORE_NMI_PULSE_CYCLES + 3; cycle += 1) {
      batched.tick(1);
      singleCycle.clockCycle();
      expect(singleCycle.nmiAsserted).toBe(batched.nmiAsserted);
    }
  });
});
