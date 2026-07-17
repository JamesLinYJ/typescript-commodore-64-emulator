// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - PRG 自动启动外部参考验证器
//
//   文件:       verifyPrgAutostartReference.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { hasBasicReadyPrompt } from '../src/core/basicStartup';
import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

const VICE_TEST_REVISION = 46_176;
const REFERENCE_FILE = 'basictest.prg';
const REFERENCE_SHA256 = '3509cc3e7f3f61d6313d3f5430df2358269deeae30423209aaeff81254106ada';
const REFERENCE_URL =
  `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
  `testprogs/C64/autostart/basic/${REFERENCE_FILE}?format=raw`;
const CACHE_PATH = resolve('output/reference/vice-autostart-basictest.prg');

const BASIC_BOOT_FRAME_LIMIT = 300;
const AUTOSTART_RESULT_FRAME_LIMIT = 120;
const C64_AUTOSTART_RESULT_ADDRESS = 0xd7ff;
const VICE_TEST_SUCCESS_VALUE = 0x00;
const VICE_TEST_FAILURE_VALUE = 0xff;
const VIC_BORDER_COLOR_ADDRESS = 0xd020;
const VIC_COLOR_MASK = 0x0f;
const VICE_TEST_SUCCESS_BORDER_COLOR = 0x05;

const BASIC_TEXT_END_POINTERS = [0x002d, 0x002f, 0x0031, 0x00ae] as const;
const VICE_TEST_EXPECTED_TEXT_END = 0x0980;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBinary(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(path)));
}

async function loadFirmware(): Promise<C64Firmware> {
  const [basic, character, kernal] = await Promise.all([
    readBinary('public/firmware/basic.901226-01.bin'),
    readBinary('public/firmware/characters.901225-01.bin'),
    readBinary('public/firmware/kernal.901227-03.bin'),
  ]);
  return { basic, character, kernal };
}

async function readCachedReference(): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(CACHE_PATH));
  } catch (error: unknown) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function validateReferenceHash(bytes: Uint8Array, source: string): void {
  const actualHash = sha256(bytes);
  if (actualHash !== REFERENCE_SHA256) {
    throw new Error(
      `VICE ${REFERENCE_FILE} SHA-256 mismatch for ${source}: received ${actualHash}.`,
    );
  }
}

async function loadReferenceProgram(): Promise<Uint8Array> {
  const cached = await readCachedReference();
  if (cached) {
    validateReferenceHash(cached, CACHE_PATH);
    return cached;
  }

  const response = await fetch(REFERENCE_URL);
  if (!response.ok) {
    throw new Error(`Unable to download the VICE PRG autostart test: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  validateReferenceHash(downloaded, REFERENCE_URL);
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, downloaded);
  return downloaded;
}

function bootToBasicReady(scheduler: PalFrameScheduler, memory: C64Memory): number {
  let readyWasAbsent = !hasBasicReadyPrompt(memory);
  for (let frame = 1; frame <= BASIC_BOOT_FRAME_LIMIT; frame += 1) {
    scheduler.runFrame();
    const ready = hasBasicReadyPrompt(memory);
    if (!ready) readyWasAbsent = true;
    else if (readyWasAbsent) return frame;
  }
  throw new Error(`C64 BASIC did not reach READY within ${BASIC_BOOT_FRAME_LIMIT} PAL frames.`);
}

function readRamWord(memory: C64Memory, address: number): number {
  return (memory.ram[address] ?? 0) | ((memory.ram[address + 1] ?? 0) << 8);
}

function assertBasicEndPointers(memory: C64Memory): void {
  for (const pointer of BASIC_TEXT_END_POINTERS) {
    const actual = readRamWord(memory, pointer);
    if (actual !== VICE_TEST_EXPECTED_TEXT_END) {
      throw new Error(
        `BASIC end pointer $${pointer.toString(16).padStart(4, '0')} is ` +
          `$${actual.toString(16).padStart(4, '0')}; expected $${VICE_TEST_EXPECTED_TEXT_END.toString(16)}.`,
      );
    }
  }
}

function runAutostartReference(
  firmware: C64Firmware,
  program: Uint8Array,
): { readonly bootFrames: number; readonly resultFrames: number } {
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = bootToBasicReady(scheduler, memory);

  installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.basicRun });
  assertBasicEndPointers(memory);

  let result: number | undefined;
  const stopObserving = memory.observeWrites(({ address, value }) => {
    if (address === C64_AUTOSTART_RESULT_ADDRESS) result = value;
  });

  let resultFrames = 0;
  try {
    for (let frame = 1; frame <= AUTOSTART_RESULT_FRAME_LIMIT; frame += 1) {
      scheduler.runFrame();
      resultFrames = frame;
      if (result !== undefined) break;
    }
  } finally {
    stopObserving();
  }

  if (result === undefined) {
    throw new Error(
      `VICE ${REFERENCE_FILE} did not write its result within ${AUTOSTART_RESULT_FRAME_LIMIT} PAL frames.`,
    );
  }
  if (result === VICE_TEST_FAILURE_VALUE) {
    throw new Error(`VICE ${REFERENCE_FILE} reported an invalid BASIC autostart environment.`);
  }
  if (result !== VICE_TEST_SUCCESS_VALUE) {
    throw new Error(
      `VICE ${REFERENCE_FILE} wrote unexpected result $${result.toString(16).padStart(2, '0')}.`,
    );
  }

  const borderColor = memory.read(VIC_BORDER_COLOR_ADDRESS) & VIC_COLOR_MASK;
  if (borderColor !== VICE_TEST_SUCCESS_BORDER_COLOR) {
    throw new Error(
      `VICE ${REFERENCE_FILE} result was successful but border color is ${borderColor}; ` +
        `expected ${VICE_TEST_SUCCESS_BORDER_COLOR}.`,
    );
  }

  return { bootFrames, resultFrames };
}

async function main(): Promise<void> {
  const [firmware, program] = await Promise.all([loadFirmware(), loadReferenceProgram()]);
  const { bootFrames, resultFrames } = runAutostartReference(firmware, program);
  console.log(
    `PASS VICE ${REFERENCE_FILE} revision ${VICE_TEST_REVISION}: ` +
      `BASIC READY in ${bootFrames} PAL frames, autostart result in ${resultFrames} frames.`,
  );
}

await main();
