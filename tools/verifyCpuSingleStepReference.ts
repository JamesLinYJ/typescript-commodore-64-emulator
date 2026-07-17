// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 6502 单步外部参考验证
//
//   文件:       verifyCpuSingleStepReference.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import type { CpuRegisters } from '../src/core/cpu/CpuRegisters';
import type { MemoryBus } from '../src/core/memory/MemoryBus';

const REFERENCE_PATH = resolve('tools/reference/SingleStep6502Samples.json');
const REFERENCE_SHA256 = '5834ea0cd258fd24d338ac93c9e7c6a18c35656e67308ff89ed35a86576e0c38';
const REFERENCE_SOURCE = {
  byteRangeLength: 65_536,
  commit: '2f6980a2d95757486c7bee24355c360e40e2a224',
  license: 'MIT',
  repository: 'https://github.com/SingleStepTests/65x02',
  samplesPerOpcode: 16,
} as const;

const CPU_ADDRESS_SPACE_SIZE = 0x1_0000;
const CPU_STACK_PAGE = 0x0100;
const OPCODE_COUNT = 0x100;

type ReferenceBusAccessKind = 'read' | 'write';
type ReferenceMemoryByte = readonly [address: number, value: number];
type ReferenceBusAccess = readonly [address: number, value: number, kind: ReferenceBusAccessKind];

interface ReferenceCpuState {
  readonly a: number;
  readonly p: number;
  readonly pc: number;
  readonly ram: readonly ReferenceMemoryByte[];
  readonly s: number;
  readonly x: number;
  readonly y: number;
}

interface ReferenceCase {
  readonly cycles: readonly ReferenceBusAccess[];
  readonly final: ReferenceCpuState;
  readonly initial: ReferenceCpuState;
  readonly name: string;
}

interface OpcodeReference {
  readonly prefixSha256: string;
  readonly samples: readonly ReferenceCase[];
}

interface SingleStepReference {
  readonly opcodes: ReadonlyMap<string, OpcodeReference>;
}

class ReferenceRam implements MemoryBus {
  private readonly bytes = new Uint8Array(CPU_ADDRESS_SPACE_SIZE);
  private readonly initialized = new Uint8Array(CPU_ADDRESS_SPACE_SIZE);
  private caseActive = false;
  readonly accesses: ReferenceBusAccess[] = [];

  beginCase(initialRam: readonly ReferenceMemoryByte[]): void {
    this.initialized.fill(0);
    this.accesses.length = 0;
    for (const [address, value] of initialRam) {
      this.bytes[address] = value;
      this.initialized[address] = 1;
    }
    this.caseActive = true;
  }

  read(address: number): number {
    const normalized = requireAddress('CPU read', address);
    if (!this.caseActive) return this.bytes[normalized];
    this.requireInitialized(normalized, 'read');
    const value = this.bytes[normalized];
    this.accesses.push([normalized, value, 'read']);
    return value;
  }

  readWord(address: number): number {
    const lowAddress = requireAddress('CPU word read', address);
    return this.read(lowAddress) | (this.read((lowAddress + 1) & 0xffff) << 8);
  }

  readStack(stackPointer: number): number {
    return this.read(CPU_STACK_PAGE + requireByte('CPU stack pointer', stackPointer));
  }

  write(address: number, value: number): void {
    const normalized = requireAddress('CPU write', address);
    const normalizedValue = requireByte('CPU write value', value);
    if (this.caseActive) {
      this.accesses.push([normalized, normalizedValue, 'write']);
      this.initialized[normalized] = 1;
    }
    this.bytes[normalized] = normalizedValue;
  }

  writeWord(address: number, value: number): void {
    const lowAddress = requireAddress('CPU word write', address);
    const normalizedValue = requireWord('CPU word write value', value);
    this.write(lowAddress, normalizedValue & 0xff);
    this.write((lowAddress + 1) & 0xffff, normalizedValue >>> 8);
  }

  writeStack(stackPointer: number, value: number): void {
    this.write(CPU_STACK_PAGE + requireByte('CPU stack pointer', stackPointer), value);
  }

  assertFinalMemory(expected: readonly ReferenceMemoryByte[]): void {
    for (const [address, value] of expected) {
      if (this.bytes[address] !== value) {
        throw new Error(
          `memory $${hex(address, 4)} expected $${hex(value)}, received $${hex(this.bytes[address])}`,
        );
      }
    }
  }

  private requireInitialized(address: number, kind: ReferenceBusAccessKind): void {
    if (this.initialized[address] === 0) {
      throw new Error(`${kind} accessed uninitialized reference address $${hex(address, 4)}`);
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function hex(value: number | undefined, width = 2): string {
  if (value === undefined) return 'undefined';
  return value.toString(16).padStart(width, '0');
}

function requireByte(label: string, value: number): number {
  return requireInteger(label, value, 0xff);
}

function requireWord(label: string, value: number): number {
  return requireInteger(label, value, 0xffff);
}

function requireAddress(label: string, value: number): number {
  return requireWord(`${label} address`, value);
}

function requireInteger(label: string, value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 0 through ${maximum}.`);
  }
  return value;
}

function requireObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isUnknownRecord(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function requireNumber(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number') throw new TypeError(`${label} must be a number.`);
  return requireInteger(label, value, maximum);
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value;
}

function parseMemoryBytes(value: unknown, label: string): readonly ReferenceMemoryByte[] {
  return requireArray(value, label).map((entry, index) => {
    const tuple = requireArray(entry, `${label}[${index}]`);
    if (tuple.length !== 2) throw new RangeError(`${label}[${index}] must contain two values.`);
    return [
      requireNumber(tuple[0], `${label}[${index}] address`, 0xffff),
      requireNumber(tuple[1], `${label}[${index}] value`, 0xff),
    ] as const;
  });
}

function parseBusCycles(value: unknown, label: string): readonly ReferenceBusAccess[] {
  return requireArray(value, label).map((entry, index) => {
    const tuple = requireArray(entry, `${label}[${index}]`);
    if (tuple.length !== 3) throw new RangeError(`${label}[${index}] must contain three values.`);
    const kind = requireString(tuple[2], `${label}[${index}] kind`);
    if (kind !== 'read' && kind !== 'write') {
      throw new RangeError(`${label}[${index}] has unsupported bus kind ${kind}.`);
    }
    return [
      requireNumber(tuple[0], `${label}[${index}] address`, 0xffff),
      requireNumber(tuple[1], `${label}[${index}] value`, 0xff),
      kind,
    ] as const;
  });
}

function parseCpuState(value: unknown, label: string): ReferenceCpuState {
  const state = requireObject(value, label);
  return {
    a: requireNumber(state.a, `${label}.a`, 0xff),
    p: requireNumber(state.p, `${label}.p`, 0xff),
    pc: requireNumber(state.pc, `${label}.pc`, 0xffff),
    ram: parseMemoryBytes(state.ram, `${label}.ram`),
    s: requireNumber(state.s, `${label}.s`, 0xff),
    x: requireNumber(state.x, `${label}.x`, 0xff),
    y: requireNumber(state.y, `${label}.y`, 0xff),
  };
}

function parseCase(value: unknown, label: string): ReferenceCase {
  const test = requireObject(value, label);
  return {
    cycles: parseBusCycles(test.cycles, `${label}.cycles`),
    final: parseCpuState(test.final, `${label}.final`),
    initial: parseCpuState(test.initial, `${label}.initial`),
    name: requireString(test.name, `${label}.name`),
  };
}

function parseReference(input: string): SingleStepReference {
  const parsed: unknown = JSON.parse(input);
  const root = requireObject(parsed, 'Single-step fixture');
  const source = requireObject(root.source, 'Single-step fixture source');
  for (const [key, expected] of Object.entries(REFERENCE_SOURCE)) {
    if (source[key] !== expected) {
      throw new Error(`Single-step source ${key} expected ${String(expected)}.`);
    }
  }

  const opcodeObject = requireObject(root.opcodes, 'Single-step opcode map');
  const opcodes = new Map<string, OpcodeReference>();
  for (let opcode = 0; opcode < OPCODE_COUNT; opcode += 1) {
    const opcodeName = opcode.toString(16).padStart(2, '0');
    const entry = requireObject(opcodeObject[opcodeName], `Opcode $${opcodeName}`);
    const prefixSha256 = requireString(entry.prefixSha256, `Opcode $${opcodeName} prefix SHA-256`);
    if (!/^[0-9a-f]{64}$/.test(prefixSha256)) {
      throw new Error(`Opcode $${opcodeName} prefix SHA-256 is invalid.`);
    }
    const samples = requireArray(entry.samples, `Opcode $${opcodeName} samples`).map(
      (sample, index) => parseCase(sample, `Opcode $${opcodeName} sample ${index}`),
    );
    if (samples.length !== REFERENCE_SOURCE.samplesPerOpcode) {
      throw new Error(
        `Opcode $${opcodeName} contains ${samples.length} samples; expected ${REFERENCE_SOURCE.samplesPerOpcode}.`,
      );
    }
    opcodes.set(opcodeName, { prefixSha256, samples });
  }
  if (Object.keys(opcodeObject).length !== OPCODE_COUNT) {
    throw new Error(`Single-step opcode map must contain exactly ${OPCODE_COUNT} entries.`);
  }
  return { opcodes };
}

function registersFromState(state: ReferenceCpuState): CpuRegisters {
  return {
    accumulator: state.a,
    indexX: state.x,
    indexY: state.y,
    programCounter: state.pc,
    stackPointer: state.s,
    status: state.p,
  };
}

function assertRegisters(actual: CpuRegisters, expected: ReferenceCpuState): void {
  const expectedRegisters = registersFromState(expected);
  for (const key of Object.keys(expectedRegisters) as (keyof CpuRegisters)[]) {
    if (actual[key] !== expectedRegisters[key]) {
      const width = key === 'programCounter' ? 4 : 2;
      throw new Error(
        `${key} expected $${hex(expectedRegisters[key], width)}, received $${hex(actual[key], width)}`,
      );
    }
  }
}

function assertBusCycles(
  actual: readonly ReferenceBusAccess[],
  expected: readonly ReferenceBusAccess[],
): void {
  if (actual.length !== expected.length) {
    throw new Error(`bus emitted ${actual.length} accesses; expected ${expected.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actualAccess = actual[index];
    const expectedAccess = expected[index];
    if (
      actualAccess?.[0] !== expectedAccess?.[0] ||
      actualAccess?.[1] !== expectedAccess?.[1] ||
      actualAccess?.[2] !== expectedAccess?.[2]
    ) {
      throw new Error(
        `bus cycle ${index + 1} expected ${JSON.stringify(expectedAccess)}, received ${JSON.stringify(actualAccess)}`,
      );
    }
  }
}

function verifyCase(
  cpu: Cpu6502,
  memory: ReferenceRam,
  test: ReferenceCase,
  opcodeName: string,
  sampleIndex: number,
): void {
  try {
    const opcodeByte = test.initial.ram.find(([address]) => address === test.initial.pc)?.[1];
    if (opcodeByte !== Number.parseInt(opcodeName, 16)) {
      throw new Error(`initial PC does not contain opcode $${opcodeName}`);
    }
    memory.beginCase(test.initial.ram);
    cpu.restoreRegisters(registersFromState(test.initial));
    let cycles = cpu.executeInstruction();
    while (cpu.isJammed && memory.accesses.length < test.cycles.length) {
      const jamCycle = cpu.executeInstruction();
      if (jamCycle !== 1) {
        throw new Error(`jammed CPU reported ${jamCycle} cycles for one observed bus cycle`);
      }
      cycles += jamCycle;
    }
    if (cycles !== test.cycles.length) {
      throw new Error(`instruction reported ${cycles} cycles; expected ${test.cycles.length}`);
    }
    assertRegisters(cpu.getRegisters(), test.final);
    memory.assertFinalMemory(test.final.ram);
    assertBusCycles(memory.accesses, test.cycles);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SingleStepTests opcode $${opcodeName} sample ${sampleIndex} (${test.name}) failed: ${detail}`,
      { cause: error },
    );
  }
}

async function main(): Promise<void> {
  const bytes = new Uint8Array(await readFile(REFERENCE_PATH));
  const actualHash = sha256(bytes);
  if (actualHash !== REFERENCE_SHA256) {
    throw new Error(`6502 single-step fixture SHA-256 mismatch: received ${actualHash}.`);
  }
  const reference = parseReference(new TextDecoder().decode(bytes));
  const memory = new ReferenceRam();
  const cpu = new Cpu6502(memory);
  let testCount = 0;

  for (let opcode = 0; opcode < OPCODE_COUNT; opcode += 1) {
    const opcodeName = opcode.toString(16).padStart(2, '0');
    const entry = reference.opcodes.get(opcodeName);
    if (!entry) throw new Error(`6502 single-step fixture has no opcode $${opcodeName}.`);
    for (let sampleIndex = 0; sampleIndex < entry.samples.length; sampleIndex += 1) {
      const test = entry.samples[sampleIndex];
      if (!test) throw new Error(`Opcode $${opcodeName} sample ${sampleIndex} is missing.`);
      verifyCase(cpu, memory, test, opcodeName, sampleIndex);
      testCount += 1;
    }
  }

  console.log(
    `PASS SingleStepTests MOS 6502 (${REFERENCE_SOURCE.commit.slice(0, 12)}): ${testCount.toLocaleString('en-US')} register, memory, and exact bus-cycle samples across all 256 opcodes.`,
  );
}

await main();
