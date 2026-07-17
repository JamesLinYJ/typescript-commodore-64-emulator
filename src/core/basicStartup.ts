import type { C64Memory } from './memory/C64Memory';

const DEFAULT_SCREEN_MEMORY_START = 0x0400;
const DEFAULT_SCREEN_CHARACTER_COUNT = 40 * 25;
const READY_PROMPT_SCREEN_CODES = [0x12, 0x05, 0x01, 0x04, 0x19, 0x2e] as const;

export function hasBasicReadyPrompt(memory: C64Memory): boolean {
  const screenEnd = DEFAULT_SCREEN_MEMORY_START + DEFAULT_SCREEN_CHARACTER_COUNT;
  const finalStart = screenEnd - READY_PROMPT_SCREEN_CODES.length;

  for (let address = DEFAULT_SCREEN_MEMORY_START; address <= finalStart; address += 1) {
    let matches = true;
    for (let index = 0; index < READY_PROMPT_SCREEN_CODES.length; index += 1) {
      if (memory.ram[address + index] !== READY_PROMPT_SCREEN_CODES[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}
