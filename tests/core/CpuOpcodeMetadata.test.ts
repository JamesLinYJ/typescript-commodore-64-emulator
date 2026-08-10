// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - NMOS 6502 操作码元数据测试
//
//   文件:       CpuOpcodeMetadata.test.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { Cpu6502 } from '../../src/core/cpu/Cpu6502';
import {
  CPU_ADDRESS_MODE,
  CPU_ADDRESS_MODE_LENGTH,
  CPU_ADDRESS_MODE_OPERAND,
  CPU_CYCLE_TEMPLATE,
  CPU_CYCLE_TEMPLATE_BASE_CYCLES,
  CPU_MEMORY_ACCESS,
  CPU_OPCODE_FLAGS,
  CPU_OPCODE_OPERATION,
  CPU_OPCODE_PLAN,
  CPU_OPCODE_PLAN_ACCESS_MASK,
  CPU_OPCODE_PLAN_ACCESS_SHIFT,
  CPU_OPCODE_PLAN_MODE_MASK,
  CPU_OPCODE_PLAN_MODE_SHIFT,
  CPU_OPCODE_PLAN_PAGE_RULE_MASK,
  CPU_OPCODE_PLAN_PAGE_RULE_SHIFT,
  CPU_OPCODE_PLAN_TEMPLATE_MASK,
  CPU_OPERATION,
  CPU_OPERATION_MNEMONIC,
  CPU_PAGE_RULE,
} from '../../src/core/cpu/CpuOpcodeMetadata';
import { TestMemory } from '../helpers/createTestSystem';

const CPU_OPCODE_COUNT = 0x100;
const MAXIMUM_INSTRUCTION_CYCLES = 8;

interface BusAccess {
  readonly address: number;
  readonly type: 'read' | 'write';
  readonly value: number;
}

class TracingMemory extends TestMemory {
  readonly accesses: BusAccess[] = [];

  override read(address: number): number {
    const normalizedAddress = address & 0xffff;
    const value = super.read(normalizedAddress);
    this.accesses.push({ address: normalizedAddress, type: 'read', value });
    return value;
  }

  override write(address: number, value: number): void {
    const normalizedAddress = address & 0xffff;
    const normalizedValue = value & 0xff;
    this.accesses.push({ address: normalizedAddress, type: 'write', value: normalizedValue });
    super.write(normalizedAddress, normalizedValue);
  }

  clearTrace(): void {
    this.accesses.length = 0;
  }
}

const EQUIVALENCE_STATES = [
  { accumulator: 0x56, indexX: 0x91, indexY: 0x37, stackPointer: 0xc4, status: 0x24 },
  { accumulator: 0xa9, indexX: 0x17, indexY: 0xb3, stackPointer: 0x42, status: 0xff },
] as const;

function createOpcodeSystem(
  opcode: number,
  stateIndex: number,
): {
  readonly cpu: Cpu6502;
  readonly memory: TracingMemory;
} {
  const memory = new TracingMemory();
  for (let address = 0; address < memory.bytes.length; address += 1) {
    memory.bytes[address] = (address * 29 + stateIndex * 71 + 0x43) & 0xff;
  }
  const programCounter = 0x20fd;
  memory.bytes[programCounter] = opcode;
  memory.bytes[programCounter + 1] = 0x7f;
  memory.bytes[programCounter + 2] = 0x20;
  memory.bytes[0xfffc] = programCounter & 0xff;
  memory.bytes[0xfffd] = programCounter >>> 8;

  const cpu = new Cpu6502(memory);
  const state = EQUIVALENCE_STATES[stateIndex];
  if (!state) throw new RangeError(`Missing equivalence state ${stateIndex}.`);
  cpu.restoreRegisters({
    accumulator: state.accumulator,
    indexX: state.indexX,
    indexY: state.indexY,
    programCounter,
    stackPointer: state.stackPointer,
    status: state.status,
  });
  memory.clearTrace();
  return { cpu, memory };
}

const DYNAMIC_PAGE_RULE_OPCODES = [
  [CPU_PAGE_RULE.BRANCH_TAKEN_THEN_CROSS, [0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]],
  [
    CPU_PAGE_RULE.INDEXED_DUMMY_ALWAYS,
    [
      0x13, 0x1b, 0x1e, 0x1f, 0x33, 0x3b, 0x3e, 0x3f, 0x53, 0x5b, 0x5e, 0x5f, 0x73, 0x7b, 0x7e,
      0x7f, 0x91, 0x99, 0x9d, 0xd3, 0xdb, 0xde, 0xdf, 0xf3, 0xfb, 0xfe, 0xff,
    ],
  ],
  [CPU_PAGE_RULE.INDIRECT_POINTER_WRAP, [0x6c]],
  [
    CPU_PAGE_RULE.READ_CROSS_ADDS_CYCLE,
    [
      0x11, 0x19, 0x1c, 0x1d, 0x31, 0x39, 0x3c, 0x3d, 0x51, 0x59, 0x5c, 0x5d, 0x71, 0x79, 0x7c,
      0x7d, 0xb1, 0xb3, 0xb9, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xd1, 0xd9, 0xdc, 0xdd, 0xf1, 0xf9,
      0xfc, 0xfd,
    ],
  ],
  [CPU_PAGE_RULE.UNSTABLE_STORE_ADDRESS_ON_CROSS, [0x93, 0x9b, 0x9c, 0x9e, 0x9f]],
] as const;

function decodePlan(plan: number) {
  return {
    access: (plan >>> CPU_OPCODE_PLAN_ACCESS_SHIFT) & CPU_OPCODE_PLAN_ACCESS_MASK,
    mode: (plan >>> CPU_OPCODE_PLAN_MODE_SHIFT) & CPU_OPCODE_PLAN_MODE_MASK,
    pageRule: (plan >>> CPU_OPCODE_PLAN_PAGE_RULE_SHIFT) & CPU_OPCODE_PLAN_PAGE_RULE_MASK,
    template: plan & CPU_OPCODE_PLAN_TEMPLATE_MASK,
  };
}

describe('CpuOpcodeMetadata', () => {
  it('defines a dense, range-safe record for every byte value', () => {
    expect(CPU_OPCODE_OPERATION).toHaveLength(CPU_OPCODE_COUNT);
    expect(CPU_OPCODE_PLAN).toHaveLength(CPU_OPCODE_COUNT);
    expect(CPU_OPCODE_FLAGS).toHaveLength(CPU_OPCODE_COUNT);
    expect(CPU_OPERATION_MNEMONIC).toHaveLength(Object.keys(CPU_OPERATION).length);
    expect(CPU_ADDRESS_MODE_OPERAND).toHaveLength(Object.keys(CPU_ADDRESS_MODE).length);

    const operationCount = Object.keys(CPU_OPERATION).length;
    const templateCount = Object.keys(CPU_CYCLE_TEMPLATE).length;
    const modeCount = Object.keys(CPU_ADDRESS_MODE).length;
    const accessCount = Object.keys(CPU_MEMORY_ACCESS).length;
    const pageRuleCount = Object.keys(CPU_PAGE_RULE).length;

    for (let opcode = 0; opcode < CPU_OPCODE_COUNT; opcode += 1) {
      const operation = CPU_OPCODE_OPERATION[opcode];
      const plan = CPU_OPCODE_PLAN[opcode];
      expect(operation).toBeDefined();
      expect(operation).toBeLessThan(operationCount);
      expect(plan).toBeDefined();

      const { access, mode, pageRule, template } = decodePlan(plan ?? 0);
      expect(template).toBeLessThan(templateCount);
      expect(mode).toBeLessThan(modeCount);
      expect(access).toBeLessThan(accessCount);
      expect(pageRule).toBeLessThan(pageRuleCount);
    }
  });

  it('matches every existing opcode base cycle count and instruction length', () => {
    const opcodeTable = new Cpu6502(new TestMemory()).getOpcodeTable();
    expect(opcodeTable).toHaveLength(CPU_OPCODE_COUNT);

    for (let opcode = 0; opcode < CPU_OPCODE_COUNT; opcode += 1) {
      const opcodeInfo = opcodeTable[opcode];
      const plan = CPU_OPCODE_PLAN[opcode];
      expect(opcodeInfo).toBeDefined();
      expect(plan).toBeDefined();

      const { mode, template } = decodePlan(plan ?? 0);
      expect(CPU_CYCLE_TEMPLATE_BASE_CYCLES[template], `opcode $${opcode.toString(16)}`).toBe(
        opcodeInfo?.cycles,
      );
      expect(CPU_ADDRESS_MODE_LENGTH[mode], `opcode $${opcode.toString(16)}`).toBe(
        opcodeInfo?.length,
      );
    }
  });

  it('classifies every dynamic page and indexed-cycle rule', () => {
    const expectedRules = new Uint8Array(CPU_OPCODE_COUNT).fill(CPU_PAGE_RULE.NONE);
    for (const [pageRule, opcodes] of DYNAMIC_PAGE_RULE_OPCODES) {
      for (const opcode of opcodes) expectedRules[opcode] = pageRule;
    }

    for (let opcode = 0; opcode < CPU_OPCODE_COUNT; opcode += 1) {
      const plan = CPU_OPCODE_PLAN[opcode];
      expect(plan).toBeDefined();
      expect(decodePlan(plan ?? 0).pageRule, `opcode $${opcode.toString(16)}`).toBe(
        expectedRules[opcode],
      );
    }
  });

  it('keeps atomic and cycle execution equivalent for all 256 opcodes', () => {
    for (let stateIndex = 0; stateIndex < EQUIVALENCE_STATES.length; stateIndex += 1) {
      for (let opcode = 0; opcode < CPU_OPCODE_COUNT; opcode += 1) {
        const atomic = createOpcodeSystem(opcode, stateIndex);
        const cycle = createOpcodeSystem(opcode, stateIndex);
        const label = `opcode $${opcode.toString(16).padStart(2, '0')}, state ${stateIndex}`;

        const atomicCycles = atomic.cpu.executeInstruction();
        let cycleCount = 0;
        let boundary = false;
        while (!boundary && !cycle.cpu.isJammed && cycleCount < MAXIMUM_INSTRUCTION_CYCLES) {
          boundary = cycle.cpu.clockCycle();
          cycleCount += 1;
        }

        expect(cycleCount, `${label} cycle count`).toBe(atomicCycles);
        expect(cycle.cpu.getRegisters(), `${label} register state`).toEqual(
          atomic.cpu.getRegisters(),
        );
        expect(cycle.memory.accesses, `${label} bus trace`).toEqual(atomic.memory.accesses);
      }
    }
  });
});
