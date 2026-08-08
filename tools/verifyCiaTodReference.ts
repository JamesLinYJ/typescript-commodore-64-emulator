// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA TOD 外部参考验证器
//
//   文件:       verifyCiaTodReference.ts
//
//   日期:       2026年08月08日
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

const UPSTREAM_TEST_REVISION = 46_176;
const REFERENCE_DIRECTORY =
  `https://sourceforge.net/p/vice-emu/code/${UPSTREAM_TEST_REVISION}/tree/` + 'testprogs/CIA/tod';
const BASIC_BOOT_FRAME_LIMIT = 300;
const RESULT_FRAME_LIMIT = 3_000;
const PROGRAM_ENTRY_ADDRESS = 0x080d;
const RESULT_ADDRESS = 0xd7ff;
const SUCCESS_RESULT = 0x00;
const FAILURE_RESULT = 0xff;
const BORDER_COLOR_ADDRESS = 0xd020;
const COLOR_MASK = 0x0f;
const SUCCESS_BORDER_COLOR = 0x05;
const SCREEN_ADDRESS = 0x0400;
const SCREEN_SAMPLE_COUNT = 0x0100;

interface CiaTodReference {
  readonly cachePath: string;
  readonly description: string;
  readonly expectedScreenCodes: readonly number[];
  readonly fileName: string;
  readonly sha256: string;
}

const CIA_TOD_REFERENCES = [
  {
    cachePath: resolve('output/reference/cia-tod-hzsync0.prg'),
    description: 'stopped-clock full TOD rewrite',
    expectedScreenCodes: [0x35, 0x36],
    fileName: 'hzsync0.prg',
    sha256: 'e5c7c57b6c974b39bdce8cd4a9a44d13a819ccb310bbea1df0670ffc31b8d333',
  },
  {
    cachePath: resolve('output/reference/cia-tod-hzsync1.prg'),
    description: 'running-clock tenths rewrite',
    expectedScreenCodes: [0x31, 0x32],
    fileName: 'hzsync1.prg',
    sha256: '7ed99136c07cdf043e193c7ec81bbdc256ea7eae941ff8135f77c153053e4b08',
  },
  {
    cachePath: resolve('output/reference/cia-tod-hzsync2.prg'),
    description: 'stopped-clock partial TOD rewrite',
    expectedScreenCodes: [0x35, 0x36],
    fileName: 'hzsync2.prg',
    sha256: '8dabc5eee8927185e8a5f6495fdc1b50489ea4a7bbf6289dce3893bed08b99d8',
  },
  {
    cachePath: resolve('output/reference/cia-tod-hzsync3.prg'),
    description: 'running-clock seconds and minutes rewrite',
    expectedScreenCodes: [0x31, 0x32],
    fileName: 'hzsync3.prg',
    sha256: '170dc939fb3c405e84bf7f2b2eb5eccf0c3acfd9572552e3a0ee7a1f6ac131a3',
  },
  {
    cachePath: resolve('output/reference/cia-tod-hzsync4.prg'),
    description: 'running-clock input-frequency switch',
    expectedScreenCodes: [0x33, 0x34],
    fileName: 'hzsync4.prg',
    sha256: '1e4a0de25928d2934ab25217fc09fa612192b1df3198953742c32497efcd0558',
  },
  {
    cachePath: resolve('output/reference/cia-tod-hzsync5.prg'),
    description: 'long stopped-clock restart',
    expectedScreenCodes: [0x35, 0x36],
    fileName: 'hzsync5.prg',
    sha256: '66b364f35ae2ac12dc0511a08e789f62c982e9a14c784b8bf23eff72bbb5bb09',
  },
] as const satisfies readonly CiaTodReference[];

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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readCachedReference(cachePath: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(cachePath));
  } catch (error: unknown) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function validateReferenceHash(
  reference: CiaTodReference,
  bytes: Uint8Array,
  source: string,
): void {
  const actualHash = sha256(bytes);
  if (actualHash !== reference.sha256) {
    throw new Error(
      `${reference.fileName} SHA-256 mismatch for ${source}: received ${actualHash}.`,
    );
  }
}

async function loadReferenceProgram(reference: CiaTodReference): Promise<Uint8Array> {
  const cached = await readCachedReference(reference.cachePath);
  if (cached) {
    validateReferenceHash(reference, cached, reference.cachePath);
    return cached;
  }

  const url = `${REFERENCE_DIRECTORY}/${reference.fileName}?format=raw`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to download ${reference.fileName}: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  validateReferenceHash(reference, downloaded, url);
  await mkdir(dirname(reference.cachePath), { recursive: true });
  await writeFile(reference.cachePath, downloaded);
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

function formatScreenCode(code: number): string {
  return `$${code.toString(16).padStart(2, '0')}`;
}

function validateScreenSamples(memory: C64Memory, reference: CiaTodReference): string {
  const samples = memory.copyRam(SCREEN_ADDRESS, SCREEN_SAMPLE_COUNT);
  const counts = new Map<number, number>();
  for (const sample of samples) {
    counts.set(sample, (counts.get(sample) ?? 0) + 1);
    if (!reference.expectedScreenCodes.includes(sample)) {
      throw new Error(
        `${reference.fileName} recorded unexpected screen sample ${formatScreenCode(sample)}; ` +
          `expected only ${reference.expectedScreenCodes.map(formatScreenCode).join(' or ')}.`,
      );
    }
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([code, count]) => `${formatScreenCode(code)}×${count}`)
    .join(', ');
}

function runReference(
  firmware: C64Firmware,
  reference: CiaTodReference,
  program: Uint8Array,
): {
  readonly bootFrames: number;
  readonly resultFrames: number;
  readonly screenSummary: string;
} {
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = bootToBasicReady(scheduler, memory);

  installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.none });
  cpu.pc = PROGRAM_ENTRY_ADDRESS;

  let result: number | undefined;
  const stopObserving = memory.observeWrites(({ address, value }) => {
    if (address === RESULT_ADDRESS) result = value;
  });

  let resultFrames = 0;
  try {
    for (let frame = 1; frame <= RESULT_FRAME_LIMIT; frame += 1) {
      scheduler.runFrame();
      resultFrames = frame;
      if (cpu.isJammed || result !== undefined) break;
    }
  } finally {
    stopObserving();
  }

  if (cpu.isJammed) {
    throw new Error(`${reference.fileName} entered the 6510 JAM state.`);
  }
  if (result === undefined) {
    throw new Error(
      `${reference.fileName} did not write its result within ${RESULT_FRAME_LIMIT} PAL frames.`,
    );
  }
  if (result === FAILURE_RESULT) {
    throw new Error(`${reference.fileName} reported a ${reference.description} mismatch.`);
  }
  if (result !== SUCCESS_RESULT) {
    throw new Error(`${reference.fileName} wrote unexpected result ${formatScreenCode(result)}.`);
  }

  const borderColor = memory.read(BORDER_COLOR_ADDRESS) & COLOR_MASK;
  if (borderColor !== SUCCESS_BORDER_COLOR) {
    throw new Error(
      `${reference.fileName} result was successful but border color is ${borderColor}; ` +
        `expected ${SUCCESS_BORDER_COLOR}.`,
    );
  }

  return {
    bootFrames,
    resultFrames,
    screenSummary: validateScreenSamples(memory, reference),
  };
}

async function main(): Promise<void> {
  const [firmware, ...programs] = await Promise.all([
    loadFirmware(),
    ...CIA_TOD_REFERENCES.map(loadReferenceProgram),
  ]);

  for (let index = 0; index < CIA_TOD_REFERENCES.length; index += 1) {
    const reference = CIA_TOD_REFERENCES[index];
    const program = programs[index];
    if (!reference || !program) {
      throw new Error(`Missing CIA TOD reference at index ${index}.`);
    }
    const result = runReference(firmware, reference, program);
    console.log(
      `PASS ${reference.fileName}: ${reference.description}, ` +
        `BASIC READY in ${result.bootFrames} PAL frames, result in ${result.resultFrames} frames, ` +
        `samples ${result.screenSummary}.`,
    );
  }

  console.log(
    `PASS CIA TOD suite revision ${UPSTREAM_TEST_REVISION}: ` +
      `${CIA_TOD_REFERENCES.length} fixed-hash programs.`,
  );
}

await main();
