import { describe, expect, it } from 'vitest';

import { hasBasicReadyPrompt } from '../../src/core/basicStartup';
import { C64Memory } from '../../src/core/memory/C64Memory';
import { createTestFirmware } from '../helpers/createTestSystem';

describe('hasBasicReadyPrompt', () => {
  it('requires the complete READY. screen-code sequence', () => {
    const memory = new C64Memory(createTestFirmware());
    const readyAddress = 0x04c8;
    memory.ram.set([0x12, 0x05, 0x01, 0x04, 0x19], readyAddress);
    expect(hasBasicReadyPrompt(memory)).toBe(false);

    memory.ram[readyAddress + 5] = 0x2e;
    expect(hasBasicReadyPrompt(memory)).toBe(true);
  });

  it('does not scan beyond the default 40 by 25 screen', () => {
    const memory = new C64Memory(createTestFirmware());
    memory.ram.set([0x12, 0x05, 0x01, 0x04, 0x19, 0x2e], 0x0800);

    expect(hasBasicReadyPrompt(memory)).toBe(false);
  });
});
