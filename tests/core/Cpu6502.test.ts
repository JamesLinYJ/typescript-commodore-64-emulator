// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - NMOS 6502/6510 CPU 测试
//
//   文件:       Cpu6502.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { Cpu6502 } from '../../src/core/cpu/Cpu6502';
import { word } from '../../src/shared/numbers';
import { createTestCpu, TestMemory } from '../helpers/createTestSystem';

const CARRY_FLAG = 0x01;
const ZERO_FLAG = 0x02;
const OVERFLOW_FLAG = 0x40;
const NEGATIVE_FLAG = 0x80;

interface BusAccess {
  readonly address: number;
  readonly kind: 'read' | 'write';
  readonly value?: number;
}

class TracingMemory extends TestMemory {
  readonly accesses: BusAccess[] = [];

  override read(address: number): number {
    const normalizedAddress = word(address);
    const value = super.read(normalizedAddress);
    this.accesses.push({ address: normalizedAddress, kind: 'read', value });
    return value;
  }

  override write(address: number, value: number): void {
    const normalizedAddress = word(address);
    super.write(normalizedAddress, value);
    this.accesses.push({ address: normalizedAddress, kind: 'write', value: value & 0xff });
  }

  clearTrace(): void {
    this.accesses.length = 0;
  }
}

function createTracingCpu(
  program: readonly number[],
  startAddress = 0x0200,
): { readonly cpu: Cpu6502; readonly memory: TracingMemory } {
  const memory = new TracingMemory();
  memory.bytes.set(program, startAddress);
  memory.writeWord(0xfffc, startAddress);
  const cpu = new Cpu6502(memory);
  memory.clearTrace();
  return { cpu, memory };
}

describe('Cpu6502', () => {
  it('enters the reset vector through the deterministic seven-cycle power-on sequence', () => {
    const memory = new TracingMemory();
    memory.bytes[0xfffc] = 0x34;
    memory.bytes[0xfffd] = 0x12;

    const cpu = new Cpu6502(memory);

    expect(memory.accesses.map(({ address, kind }) => [address, kind])).toEqual([
      [0x0000, 'read'],
      [0x0000, 'read'],
      [0x0100, 'read'],
      [0x01ff, 'read'],
      [0x01fe, 'read'],
      [0xfffc, 'read'],
      [0xfffd, 'read'],
    ]);
    expect(cpu.getRegisters()).toEqual({
      accumulator: 0x00,
      indexX: 0x00,
      indexY: 0x00,
      programCounter: 0x1234,
      stackPointer: 0xfd,
      status: 0x24,
    });
  });

  it('preserves warm-reset registers while performing the exact reset bus sequence', () => {
    const { cpu, memory } = createTracingCpu([0xea]);
    cpu.restoreRegisters({
      accumulator: 0x12,
      indexX: 0x34,
      indexY: 0x56,
      programCounter: 0x4567,
      stackPointer: 0x80,
      status: 0xd9,
    });
    memory.bytes[0xfffc] = 0xcd;
    memory.bytes[0xfffd] = 0xab;

    expect(cpu.reset()).toBe(7);
    expect(memory.accesses.map(({ address, kind }) => [address, kind])).toEqual([
      [0x4567, 'read'],
      [0x4567, 'read'],
      [0x0180, 'read'],
      [0x017f, 'read'],
      [0x017e, 'read'],
      [0xfffc, 'read'],
      [0xfffd, 'read'],
    ]);
    expect(cpu.getRegisters()).toEqual({
      accumulator: 0x12,
      indexX: 0x34,
      indexY: 0x56,
      programCounter: 0xabcd,
      stackPointer: 0x7d,
      status: 0xdd,
    });
  });

  it('restores a validated instruction-boundary register state', () => {
    const { cpu } = createTestCpu([0xea]);
    cpu.restoreRegisters({
      accumulator: 0x12,
      indexX: 0x34,
      indexY: 0x56,
      programCounter: 0x789a,
      stackPointer: 0xbc,
      status: 0xad,
    });

    expect(cpu.getRegisters()).toEqual({
      accumulator: 0x12,
      indexX: 0x34,
      indexY: 0x56,
      programCounter: 0x789a,
      stackPointer: 0xbc,
      status: 0xad,
    });
    expect(() =>
      cpu.restoreRegisters({
        ...cpu.getRegisters(),
        programCounter: 0x1_0000,
      }),
    ).toThrow(/program counter/);
  });

  it('makes ANC carry equal to the result sign instead of preserving the old carry', () => {
    const { cpu } = createTestCpu([0x0b, 0xb8]);
    cpu.restoreRegisters({
      ...cpu.getRegisters(),
      accumulator: 0x77,
      status: 0xaf,
    });

    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.getRegisters()).toMatchObject({ accumulator: 0x30, status: 0x2c });
  });

  it('applies NMOS decimal adjustment to invalid BCD digits without normalizing them first', () => {
    const { cpu } = createTestCpu([0x69, 0x16]);
    cpu.restoreRegisters({
      ...cpu.getRegisters(),
      accumulator: 0xdd,
      status: 0xab,
    });

    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.getRegisters()).toMatchObject({ accumulator: 0x5a, status: 0xa9 });
  });

  it('derives undocumented ARR carry and overflow from the rotated result bits', () => {
    const { cpu } = createTestCpu([0x6b, 0x77]);
    cpu.restoreRegisters({
      ...cpu.getRegisters(),
      accumulator: 0x9b,
      status: 0xa7,
    });

    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.getRegisters()).toMatchObject({ accumulator: 0x89, status: 0xa4 });
  });

  it('passes undocumented XAA through the NMOS internal data mask', () => {
    const { cpu } = createTestCpu([0x8b, 0x16]);
    cpu.restoreRegisters({
      ...cpu.getRegisters(),
      accumulator: 0xa4,
      indexX: 0xd3,
      status: 0x6b,
    });

    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.getRegisters()).toMatchObject({ accumulator: 0x02, status: 0x69 });
  });

  it('lets a page-crossing AHX value drive both the data bus and address high byte', () => {
    const { cpu, memory } = createTracingCpu([0x93, 0x89]);
    memory.bytes[0x0089] = 0x81;
    memory.bytes[0x008a] = 0x40;
    memory.bytes[0x4071] = 0x2e;
    cpu.restoreRegisters({
      ...cpu.getRegisters(),
      accumulator: 0x88,
      indexX: 0xc4,
      indexY: 0xf0,
    });

    expect(cpu.executeInstruction()).toBe(6);
    expect(memory.bytes[0x0071]).toBe(0x00);
    expect(memory.accesses.map(({ address, kind, value }) => [address, kind, value])).toEqual([
      [0x0200, 'read', 0x93],
      [0x0201, 'read', 0x89],
      [0x0089, 'read', 0x81],
      [0x008a, 'read', 0x40],
      [0x4071, 'read', 0x2e],
      [0x0071, 'write', 0x00],
    ]);
  });

  it('clears undocumented SBX carry when its subtraction borrows', () => {
    const { cpu } = createTestCpu([0xcb, 0x6d]);
    cpu.restoreRegisters({
      ...cpu.getRegisters(),
      accumulator: 0x82,
      indexX: 0x01,
      status: 0x2b,
    });

    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.getRegisters()).toMatchObject({ indexX: 0x93, status: 0xa8 });
  });

  it('keeps KIL/JAM locked while reproducing its persistent NMOS bus sequence', () => {
    const { cpu, memory } = createTracingCpu([0x02, 0xa5]);

    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.isJammed).toBe(true);
    expect(cpu.getRegisters().programCounter).toBe(0x0201);
    expect(cpu.canAcceptMaskableInterrupt(10)).toBe(false);
    expect(cpu.canAcceptNonMaskableInterrupt(10)).toBe(false);
    expect(cpu.nmi()).toBe(0);
    expect(cpu.serviceMaskableInterrupt()).toBe(0);

    for (let cycle = 2; cycle < 11; cycle += 1) {
      expect(cpu.executeInstruction()).toBe(1);
    }
    expect(memory.accesses.map(({ address, kind }) => [address, kind])).toEqual([
      [0x0200, 'read'],
      [0x0201, 'read'],
      [0xffff, 'read'],
      [0xfffe, 'read'],
      [0xfffe, 'read'],
      [0xffff, 'read'],
      [0xffff, 'read'],
      [0xffff, 'read'],
      [0xffff, 'read'],
      [0xffff, 'read'],
      [0xffff, 'read'],
    ]);

    expect(cpu.reset()).toBe(7);
    expect(cpu.isJammed).toBe(false);
    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.isJammed).toBe(true);
    cpu.restoreRegisters(cpu.getRegisters());
    expect(cpu.isJammed).toBe(false);
  });

  it('sets the overflow flag when the external SO pin edge is sampled', () => {
    const { cpu } = createTestCpu([0xb8]); // CLV
    cpu.executeInstruction();
    expect(cpu.getRegisters().status & OVERFLOW_FLAG).toBe(0);

    cpu.signalSetOverflow();
    expect(cpu.getRegisters().status & OVERFLOW_FLAG).toBe(OVERFLOW_FLAG);
  });

  it('executes load, add, and store instructions with accurate flags and cycles', () => {
    const { cpu, memory } = createTestCpu([
      0xa9,
      0x7f, // LDA #$7F
      0x69,
      0x01, // ADC #$01
      0x8d,
      0x00,
      0x04, // STA $0400
    ]);

    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.executeInstruction()).toBe(2);
    expect(cpu.executeInstruction()).toBe(4);

    const registers = cpu.getRegisters();
    expect(registers.accumulator).toBe(0x80);
    expect(registers.status & NEGATIVE_FLAG).toBe(NEGATIVE_FLAG);
    expect(registers.status & OVERFLOW_FLAG).toBe(OVERFLOW_FLAG);
    expect(memory.read(0x0400)).toBe(0x80);
  });

  it('sets subtraction carry and signed overflow correctly', () => {
    const { cpu } = createTestCpu([
      0xa9,
      0x80, // LDA #$80
      0x38, // SEC
      0xe9,
      0x01, // SBC #$01
    ]);

    cpu.executeInstruction();
    cpu.executeInstruction();
    cpu.executeInstruction();

    const registers = cpu.getRegisters();
    expect(registers.accumulator).toBe(0x7f);
    expect(registers.status & CARRY_FLAG).toBe(CARRY_FLAG);
    expect(registers.status & OVERFLOW_FLAG).toBe(OVERFLOW_FLAG);
    expect(registers.status & NEGATIVE_FLAG).toBe(0);
    expect(registers.status & ZERO_FLAG).toBe(0);
  });

  it('wraps indirect pointers within the zero page', () => {
    const { cpu, memory } = createTestCpu([
      0xa2,
      0x00, // LDX #$00
      0xa1,
      0xff, // LDA ($FF,X)
    ]);
    memory.write(0x00ff, 0x34);
    memory.write(0x0000, 0x12);
    memory.write(0x0100, 0x99);
    memory.write(0x1234, 0xab);

    cpu.executeInstruction();
    cpu.executeInstruction();

    expect(cpu.getRegisters().accumulator).toBe(0xab);
  });

  it('performs packed BCD addition and subtraction in decimal mode', () => {
    const { cpu } = createTestCpu([
      0xf8, // SED
      0x18, // CLC
      0xa9,
      0x45, // LDA #$45
      0x69,
      0x55, // ADC #$55 -> $00 with carry
      0xe9,
      0x01, // SBC #$01 -> $99 with carry clear
    ]);

    cpu.executeInstruction();
    cpu.executeInstruction();
    cpu.executeInstruction();
    cpu.executeInstruction();
    expect(cpu.getRegisters().accumulator).toBe(0x00);
    expect(cpu.getRegisters().status & CARRY_FLAG).toBe(CARRY_FLAG);

    cpu.executeInstruction();
    expect(cpu.getRegisters().accumulator).toBe(0x99);
    expect(cpu.getRegisters().status & CARRY_FLAG).toBe(0);
  });

  it('restores the program counter and stack after JSR and RTS', () => {
    const { cpu, memory } = createTestCpu([
      0x20,
      0x07,
      0x02, // JSR $0207
      0xa9,
      0x2a, // LDA #$2A
      0xea,
      0xea,
      0xa9,
      0x10, // LDA #$10
      0x60, // RTS
    ]);

    const initialStackPointer = cpu.getRegisters().stackPointer;
    cpu.executeInstruction();
    cpu.executeInstruction();
    cpu.executeInstruction();
    cpu.executeInstruction();

    expect(cpu.getRegisters()).toMatchObject({
      accumulator: 0x2a,
      programCounter: 0x0205,
      stackPointer: initialStackPointer,
    });
    expect(memory.readStack(initialStackPointer)).toBe(0x02);
  });

  it('performs every JSR bus access in hardware order', () => {
    const { cpu, memory } = createTracingCpu([0x20, 0x34, 0x12]);
    const initialStackPointer = cpu.getRegisters().stackPointer;
    const firstStackAddress = 0x0100 + initialStackPointer;
    const secondStackAddress = 0x0100 + ((initialStackPointer - 1) & 0xff);

    expect(cpu.executeInstruction()).toBe(6);
    expect(memory.accesses).toEqual([
      { address: 0x0200, kind: 'read', value: 0x20 },
      { address: 0x0201, kind: 'read', value: 0x34 },
      { address: firstStackAddress, kind: 'read', value: 0x00 },
      { address: firstStackAddress, kind: 'write', value: 0x02 },
      { address: secondStackAddress, kind: 'write', value: 0x02 },
      { address: 0x0202, kind: 'read', value: 0x12 },
    ]);
  });

  it('writes the original value before the result of a read-modify-write instruction', () => {
    const { cpu, memory } = createTracingCpu([0xe6, 0x10]); // INC $10
    memory.bytes[0x0010] = 0x7f;

    expect(cpu.executeInstruction()).toBe(5);
    expect(memory.accesses).toEqual([
      { address: 0x0200, kind: 'read', value: 0xe6 },
      { address: 0x0201, kind: 'read', value: 0x10 },
      { address: 0x0010, kind: 'read', value: 0x7f },
      { address: 0x0010, kind: 'write', value: 0x7f },
      { address: 0x0010, kind: 'write', value: 0x80 },
    ]);
  });

  it('uses the uncorrected address for the indexed-store dummy read', () => {
    const { cpu, memory } = createTracingCpu([
      0xa9,
      0x42, // LDA #$42
      0xa2,
      0x01, // LDX #$01
      0x9d,
      0xff,
      0x12, // STA $12FF,X
    ]);
    cpu.executeInstruction();
    cpu.executeInstruction();
    memory.clearTrace();

    expect(cpu.executeInstruction()).toBe(5);
    expect(memory.accesses).toEqual([
      { address: 0x0204, kind: 'read', value: 0x9d },
      { address: 0x0205, kind: 'read', value: 0xff },
      { address: 0x0206, kind: 'read', value: 0x12 },
      { address: 0x1200, kind: 'read', value: 0x00 },
      { address: 0x1300, kind: 'write', value: 0x42 },
    ]);
  });

  it('performs the taken-branch dummy read at the sequential program counter', () => {
    const { cpu, memory } = createTracingCpu([0xd0, 0x02]); // BNE $0204

    expect(cpu.executeInstruction()).toBe(3);
    expect(cpu.getRegisters().programCounter).toBe(0x0204);
    expect(memory.accesses).toEqual([
      { address: 0x0200, kind: 'read', value: 0xd0 },
      { address: 0x0201, kind: 'read', value: 0x02 },
      { address: 0x0202, kind: 'read', value: 0x00 },
    ]);
  });

  it('emits one real bus access for every declared cycle of every opcode', () => {
    for (let opcode = 0; opcode <= 0xff; opcode += 1) {
      const { cpu, memory } = createTracingCpu([opcode, 0x00, 0x02]);

      const cycles = cpu.executeInstruction();

      expect(memory.accesses.length, `opcode $${opcode.toString(16).padStart(2, '0')}`).toBe(
        cycles,
      );
    }
  });
});
