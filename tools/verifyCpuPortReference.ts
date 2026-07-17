import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import type { MemoryBus } from '../src/core/memory/MemoryBus';
import { ProcessorPort6510 } from '../src/core/memory/ProcessorPort6510';
import { byte, word } from '../src/shared/numbers';

const REFERENCE_URL =
  'https://sourceforge.net/p/vice-emu/code/HEAD/tree/testprogs/CPU/cpuport/test1.prg?format=raw';
const REFERENCE_SHA256 = '86d956ff6af4fe33ac655e5d025ccf36b392aed34de5fa7fc04d5115196c80b9';
const CACHE_PATH = resolve('output/reference/cpuport-test1.prg');
const MACHINE_CODE_ENTRY = 0x080d;
const VICE_TEST_EXIT_PORT = 0xd7ff;
const MAXIMUM_INSTRUCTIONS = 10_000;

class CpuPortReferenceMemory implements MemoryBus {
  readonly bytes = new Uint8Array(0x1_0000);
  readonly processorPort = new ProcessorPort6510();
  exitCode: number | undefined;

  read(address: number): number {
    const normalized = word(address);
    if (normalized === 0x0000) return this.processorPort.directionRegister;
    if (normalized === 0x0001) return this.processorPort.dataRegister;
    return this.bytes[normalized] ?? 0;
  }

  readWord(address: number): number {
    return this.read(address) | (this.read(address + 1) << 8);
  }

  readStack(stackPointer: number): number {
    return this.read(0x0100 + byte(stackPointer));
  }

  write(address: number, value: number): void {
    const normalized = word(address);
    const normalizedValue = byte(value);
    if (normalized === 0x0000) this.processorPort.writeDirection(normalizedValue);
    else if (normalized === 0x0001) this.processorPort.writeData(normalizedValue);
    else this.bytes[normalized] = normalizedValue;
    if (normalized === VICE_TEST_EXIT_PORT) this.exitCode = normalizedValue;
  }

  writeWord(address: number, value: number): void {
    this.write(address, value);
    this.write(address + 1, value >> 8);
  }

  writeStack(stackPointer: number, value: number): void {
    this.write(0x0100 + byte(stackPointer), value);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function loadReferenceProgram(): Promise<Uint8Array> {
  try {
    const cached = new Uint8Array(await readFile(CACHE_PATH));
    if (sha256(cached) === REFERENCE_SHA256) return cached;
  } catch {
    // 首次运行参考测试时缓存尚不存在，这是正常路径。
  }

  const response = await fetch(REFERENCE_URL);
  if (!response.ok) {
    throw new Error(`Unable to download the VICE CPU-port test: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const actualHash = sha256(downloaded);
  if (actualHash !== REFERENCE_SHA256) {
    throw new Error(`VICE CPU-port test SHA-256 mismatch: received ${actualHash}.`);
  }
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, downloaded);
  return downloaded;
}

async function main(): Promise<void> {
  const program = await loadReferenceProgram();
  const memory = new CpuPortReferenceMemory();
  const cpu = new Cpu6502(memory);
  const loadAddress = (program[0] ?? 0) | ((program[1] ?? 0) << 8);
  memory.bytes.set(program.subarray(2), loadAddress);
  cpu.pc = MACHINE_CODE_ENTRY;

  let executed = 0;
  while (memory.exitCode === undefined && executed < MAXIMUM_INSTRUCTIONS) {
    const cycles = cpu.executeInstruction(false);
    memory.processorPort.tick(cycles);
    executed += 1;
  }

  if (memory.exitCode === undefined) {
    throw new Error(
      `VICE CPU-port test did not report a result within ${MAXIMUM_INSTRUCTIONS.toLocaleString('en-US')} instructions.`,
    );
  }
  if (memory.exitCode !== 0) {
    const failedStep = memory.bytes[0x0400] ?? 0;
    throw new Error(
      `VICE CPU-port test failed with exit code $${memory.exitCode.toString(16).padStart(2, '0')} (screen diagnostic $${failedStep.toString(16).padStart(2, '0')}).`,
    );
  }

  console.log(
    `PASS VICE 6510 CPU-port test1.prg: ${executed.toLocaleString('en-US')} instructions, exit code $00.`,
  );
}

await main();
