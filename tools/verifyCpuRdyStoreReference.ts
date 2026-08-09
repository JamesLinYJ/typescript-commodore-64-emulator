// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CPU RDY 变址写外部参考验证
//
//   文件:       verifyCpuRdyStoreReference.ts
//
//   日期:       2026年08月09日
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

const UPSTREAM_TEST_COMMIT = 'ef8e8efe52f3d43df7acefad132c6506239bddee';
const UPSTREAM_DIRECTORY = 'CPU/shxy';
const REFERENCES = [
  {
    cachePath: resolve('output/reference/cpu-rdy-shx.prg'),
    fileName: 'shxy2.prg',
    mnemonic: 'SHX',
    sha256: 'ce9d607bc16ee491468787f99eb5b2600b2173cdfa1ad06b9374a08d869faca8',
  },
  {
    cachePath: resolve('output/reference/cpu-rdy-shy.prg'),
    fileName: 'shyx2.prg',
    mnemonic: 'SHY',
    sha256: '28c8312ca51b06dd4c171f54d796cedbddd35a47711fd9c413d31c5585e48189',
  },
] as const;
const START_MODES = [PRG_START_MODE.basicRun, PRG_START_MODE.direct] as const;
const BASIC_BOOT_FRAME_LIMIT = 300;
const PROGRAM_ENTRY_ADDRESS = 0x080e;
const RESULT_ADDRESS = 0xd7ff;
const RESULT_FRAME_LIMIT = 20;
const RESULT_MEMORY_ADDRESS = 0x1080;
const SUCCESS_BORDER_COLOR = 5;
const SUCCESS_RESULT = 0x00;
const EXPECTED_BYTES = Uint8Array.of(
  0x00,
  0x01,
  0x02,
  0x03,
  0x04,
  0x05,
  0x06,
  0x07,
  0x08,
  0x09,
  0x0a,
  0x0b,
  0x0c,
  0x0d,
  0x0e,
  0x0f,
  0x10,
  0x11,
  0x12,
  0x13,
  0x10,
  0x11,
  0x10,
  0x11,
);

async function readBinary(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(path)));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function loadReferenceProgram(reference: (typeof REFERENCES)[number]): Promise<Uint8Array> {
  try {
    const cached = await readBinary(reference.cachePath);
    const actualHash = sha256(cached);
    if (actualHash !== reference.sha256) {
      throw new Error(`Cached ${reference.fileName} SHA-256 mismatch: received ${actualHash}.`);
    }
    return cached;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) throw error;
  }

  const url =
    `https://raw.githubusercontent.com/libsidplayfp/VICE-testprogs/${UPSTREAM_TEST_COMMIT}/` +
    `${UPSTREAM_DIRECTORY}/${reference.fileName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to download ${reference.fileName}: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const actualHash = sha256(downloaded);
  if (actualHash !== reference.sha256) {
    throw new Error(`Downloaded ${reference.fileName} SHA-256 mismatch: received ${actualHash}.`);
  }
  await mkdir(dirname(reference.cachePath), { recursive: true });
  await writeFile(reference.cachePath, downloaded);
  return downloaded;
}

async function loadFirmware(): Promise<C64Firmware> {
  const [basic, character, kernal] = await Promise.all([
    readBinary('public/firmware/basic.901226-01.bin'),
    readBinary('public/firmware/characters.901225-01.bin'),
    readBinary('public/firmware/kernal.901227-03.bin'),
  ]);
  return { basic, character, kernal };
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

function firstDifference(actual: Uint8Array): number {
  return actual.findIndex((value, index) => value !== EXPECTED_BYTES[index]);
}

function formatBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(' ');
}

function runReference(
  firmware: C64Firmware,
  program: Uint8Array,
  reference: (typeof REFERENCES)[number],
  startMode: (typeof START_MODES)[number],
): { readonly bootFrames: number; readonly resultFrames: number } {
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = bootToBasicReady(scheduler, memory);

  installPrg(parsePrg(program), memory, cpu, {
    entryAddress: PROGRAM_ENTRY_ADDRESS,
    startMode,
  });
  let result: number | undefined;
  const stopObserving = memory.observeWrites(({ address, value }) => {
    if (address === RESULT_ADDRESS) result ??= value;
  });

  let resultFrames = 0;
  try {
    for (let frame = 1; frame <= RESULT_FRAME_LIMIT; frame += 1) {
      scheduler.runFrame(undefined, true);
      resultFrames = frame;
      if (result !== undefined || cpu.isJammed) break;
    }
  } finally {
    stopObserving();
  }

  const label = `${reference.fileName} ${startMode}`;
  if (cpu.isJammed) throw new Error(`${label} entered the 6510 JAM state.`);
  if (result !== SUCCESS_RESULT) {
    throw new Error(
      `${label} returned ${result === undefined ? 'no result' : `$${result.toString(16).padStart(2, '0')}`} ` +
        `within ${RESULT_FRAME_LIMIT} PAL frames.`,
    );
  }

  const borderColor = memory.read(0xd020) & 0x0f;
  if (borderColor !== SUCCESS_BORDER_COLOR) {
    throw new Error(`${label} reported success with border ${borderColor}.`);
  }

  const actualBytes = memory.copyRam(RESULT_MEMORY_ADDRESS, EXPECTED_BYTES.length);
  const difference = firstDifference(actualBytes);
  if (difference >= 0) {
    throw new Error(
      `${label} first differs at $${(RESULT_MEMORY_ADDRESS + difference).toString(16)}: ` +
        `expected $${(EXPECTED_BYTES[difference] ?? 0).toString(16).padStart(2, '0')}, ` +
        `received $${(actualBytes[difference] ?? 0).toString(16).padStart(2, '0')}; ` +
        `dump=${formatBytes(actualBytes)}.`,
    );
  }
  return { bootFrames, resultFrames };
}

const firmware = await loadFirmware();
for (const reference of REFERENCES) {
  const program = await loadReferenceProgram(reference);
  for (const startMode of START_MODES) {
    const result = runReference(firmware, program, reference, startMode);
    console.log(
      `PASS ${reference.mnemonic} ${reference.fileName} commit ${UPSTREAM_TEST_COMMIT} (${startMode}): ` +
        `BASIC READY in ${result.bootFrames} PAL frames, result in ${result.resultFrames} frames.`,
    );
  }
}
