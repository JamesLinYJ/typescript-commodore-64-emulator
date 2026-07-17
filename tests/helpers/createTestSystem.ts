import { Cpu6502 } from '../../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../../src/core/memory/C64Memory';
import type { MemoryBus } from '../../src/core/memory/MemoryBus';
import { byte, word } from '../../src/shared/numbers';

export class TestMemory implements MemoryBus {
  readonly bytes = new Uint8Array(0x1_0000);

  read(address: number): number {
    return this.bytes[word(address)] ?? 0;
  }

  readWord(address: number): number {
    return this.read(address) | (this.read(address + 1) << 8);
  }

  readStack(stackPointer: number): number {
    return this.read(0x0100 + byte(stackPointer));
  }

  write(address: number, value: number): void {
    this.bytes[word(address)] = byte(value);
  }

  writeWord(address: number, value: number): void {
    this.write(address, value);
    this.write(address + 1, value >> 8);
  }

  writeStack(stackPointer: number, value: number): void {
    this.write(0x0100 + byte(stackPointer), value);
  }
}

export function createTestCpu(
  program: readonly number[],
  startAddress = 0x0200,
): { readonly cpu: Cpu6502; readonly memory: TestMemory } {
  const memory = new TestMemory();
  memory.bytes.set(program, startAddress);
  memory.writeWord(0xfffc, startAddress);
  const cpu = new Cpu6502(memory);
  return { cpu, memory };
}

export function createTestFirmware(): C64Firmware {
  return {
    basic: new Uint8Array(0x2000).fill(0xba),
    character: new Uint8Array(0x1000).fill(0xcc),
    kernal: new Uint8Array(0x2000).fill(0xe1),
  };
}

export function createC64System(startAddress = 0x0200): {
  readonly cpu: Cpu6502;
  readonly firmware: C64Firmware;
  readonly memory: C64Memory;
} {
  const firmware = createTestFirmware();
  firmware.kernal[0x1ffc] = byte(startAddress);
  firmware.kernal[0x1ffd] = byte(startAddress >> 8);
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  return { cpu, firmware, memory };
}
