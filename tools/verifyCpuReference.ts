import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import type { MemoryBus } from '../src/core/memory/MemoryBus';
import { byte, word } from '../src/shared/numbers';

const REFERENCE_URL =
  'https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/6502_functional_test.bin';
const REFERENCE_SHA256 = 'fa12bfc761e6f9057e4cc01a665a7b800ff01ae91f598af1e39a1201d01953fd';
const CACHE_PATH = resolve('output/reference/6502_functional_test.bin');
const START_ADDRESS = 0x0400;
const SUCCESS_TRAP = 0x3469;
const MAXIMUM_INSTRUCTIONS = 40_000_000;

class ReferenceMemory implements MemoryBus {
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function loadReferenceBinary(): Promise<Uint8Array> {
  try {
    const cached = new Uint8Array(await readFile(CACHE_PATH));
    if (sha256(cached) === REFERENCE_SHA256) return cached;
  } catch {
    // 首次运行参考测试时缓存尚不存在，这是正常路径。
  }

  const response = await fetch(REFERENCE_URL);
  if (!response.ok) {
    throw new Error(`Unable to download Klaus test image: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const actualHash = sha256(downloaded);
  if (actualHash !== REFERENCE_SHA256) {
    throw new Error(`Klaus test image SHA-256 mismatch: received ${actualHash}.`);
  }
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, downloaded);
  return downloaded;
}

async function main(): Promise<void> {
  const image = await loadReferenceBinary();
  if (image.length !== 0x1_0000) {
    throw new RangeError(`Klaus test image must contain 65536 bytes; received ${image.length}.`);
  }

  const memory = new ReferenceMemory();
  memory.bytes.set(image);
  const cpu = new Cpu6502(memory);
  cpu.pc = START_ADDRESS;
  const startedAt = performance.now();

  for (let instructions = 1; instructions <= MAXIMUM_INSTRUCTIONS; instructions += 1) {
    const previousProgramCounter = cpu.pc;
    cpu.executeInstruction(false);
    if (cpu.pc !== previousProgramCounter) continue;
    if (cpu.pc !== SUCCESS_TRAP) {
      throw new Error(
        `Klaus functional test entered failure trap $${cpu.pc.toString(16).padStart(4, '0')} after ${instructions.toLocaleString('en-US')} instructions.`,
      );
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    console.log(
      `PASS Klaus 6502 functional test: ${instructions.toLocaleString('en-US')} instructions, success trap $${SUCCESS_TRAP.toString(16)}, ${elapsedSeconds.toFixed(2)} s.`,
    );
    return;
  }

  throw new Error(
    `Klaus functional test did not reach success within ${MAXIMUM_INSTRUCTIONS.toLocaleString('en-US')} instructions.`,
  );
}

await main();
