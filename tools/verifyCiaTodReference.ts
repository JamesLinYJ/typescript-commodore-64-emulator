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
import { MOS_6526_MODEL, type Mos6526Model } from '../src/devices/Mos6526Model';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

const UPSTREAM_TEST_REVISION = 46_176;
const FIXED_TEST_COMMIT = 'ef8e8efe52f3d43df7acefad132c6506239bddee';
const REFERENCE_DIRECTORY =
  `https://sourceforge.net/p/vice-emu/code/${UPSTREAM_TEST_REVISION}/tree/` + 'testprogs/CIA/tod';
const FIXED_TEST_REFERENCE_DIRECTORY =
  `https://raw.githubusercontent.com/libsidplayfp/VICE-testprogs/${FIXED_TEST_COMMIT}/` + 'CIA/tod';
const FIX_TSEC_ONLY_ARGUMENT = '--fix-tsec-only';
const ALARM_COND_ONLY_ARGUMENT = '--alarm-cond-only';
const BASIC_BOOT_FRAME_LIMIT = 300;
const RESULT_FRAME_LIMIT = 3_500;
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
  readonly exhaustiveMatrix?: boolean;
  readonly expectedScreenCodes: readonly number[] | undefined;
  readonly fileName: string;
  readonly requiredSuccessWrites?: number;
  readonly sha256: string;
}

const CIA_TOD_REFERENCES: readonly CiaTodReference[] = [
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
  {
    cachePath: resolve('output/reference/cia-tod-hzsync6.prg'),
    description: 'running-clock 60-to-50 Hz terminal-phase switch',
    expectedScreenCodes: [0x31, 0x36, 0x37],
    fileName: 'hzsync6.prg',
    sha256: '39a5fb6c2fc930ee31c8f852be8c13e61d9521892db395ce112d4a1a3389f277',
  },
  {
    cachePath: resolve('output/reference/cia-tod-fix-tsec.prg'),
    description: 'independent invalid BCD digit increment',
    exhaustiveMatrix: true,
    expectedScreenCodes: undefined,
    fileName: 'fix-tsec.prg',
    sha256: '9d7c493003517b32135d1af56965dbc587eb68cbc3ddd029c78760bf241b64a3',
  },
  {
    cachePath: resolve('output/reference/cia-tod-alarm-cond.prg'),
    description: 'alarm comparison after TOD register writes',
    exhaustiveMatrix: true,
    expectedScreenCodes: undefined,
    fileName: 'alarm-cond.prg',
    requiredSuccessWrites: 2,
    sha256: '9f2d76ab4d39411e66957c7e04e3c2d2a20a695cbe2e455de2d0555bb4919b87',
  },
  {
    cachePath: resolve('output/reference/cia-tod-alarm-cond2.prg'),
    description: 'alarm comparison after alarm register writes',
    exhaustiveMatrix: true,
    expectedScreenCodes: undefined,
    fileName: 'alarm-cond2.prg',
    requiredSuccessWrites: 2,
    sha256: '5e3e6b3f1ee2631c06a879fe4c554fbbb8eb6e0eb951fd1dea6c438b061e8d1c',
  },
];

const START_MODES = [PRG_START_MODE.basicRun, PRG_START_MODE.direct] as const;
const CIA_MODELS = [MOS_6526_MODEL.original, MOS_6526_MODEL.revised] as const;

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

  const url = reference.exhaustiveMatrix
    ? `${FIXED_TEST_REFERENCE_DIRECTORY}/${reference.fileName}`
    : `${REFERENCE_DIRECTORY}/${reference.fileName}?format=raw`;
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

function validateScreenSamples(memory: C64Memory, reference: CiaTodReference): string | undefined {
  const expectedScreenCodes = reference.expectedScreenCodes;
  if (!expectedScreenCodes) return undefined;

  const samples = memory.copyRam(SCREEN_ADDRESS, SCREEN_SAMPLE_COUNT);
  const counts = new Map<number, number>();
  for (const sample of samples) {
    counts.set(sample, (counts.get(sample) ?? 0) + 1);
    if (!expectedScreenCodes.includes(sample)) {
      throw new Error(
        `${reference.fileName} recorded unexpected screen sample ${formatScreenCode(sample)}; ` +
          `expected only ${expectedScreenCodes.map(formatScreenCode).join(' or ')}.`,
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
  startMode: (typeof START_MODES)[number],
  model: Mos6526Model,
): {
  readonly bootFrames: number;
  readonly resultWrites: readonly number[];
  readonly resultFrames: number;
  readonly screenSummary: string | undefined;
} {
  const memory = new C64Memory(firmware, { ciaModels: { cia1: model, cia2: model } });
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = bootToBasicReady(scheduler, memory);

  installPrg(parsePrg(program), memory, cpu, {
    entryAddress: PROGRAM_ENTRY_ADDRESS,
    startMode,
  });

  const requiredSuccessWrites = reference.requiredSuccessWrites ?? 1;
  const resultWrites: number[] = [];
  const stopObserving = memory.observeWrites(({ address, value }) => {
    if (address === RESULT_ADDRESS) resultWrites.push(value);
  });

  let resultFrames = 0;
  try {
    for (let frame = 1; frame <= RESULT_FRAME_LIMIT; frame += 1) {
      scheduler.runFrame();
      resultFrames = frame;
      if (cpu.isJammed || resultWrites.length >= requiredSuccessWrites) break;
    }
  } finally {
    stopObserving();
  }

  const label = `${reference.fileName} ${startMode} ${model}`;
  if (cpu.isJammed) throw new Error(`${label} entered the 6510 JAM state.`);
  if (resultWrites.length < requiredSuccessWrites) {
    throw new Error(
      `${label} wrote ${resultWrites.length}/${requiredSuccessWrites} required results ` +
        `within ${RESULT_FRAME_LIMIT} PAL frames.`,
    );
  }
  const unexpectedResultIndex = resultWrites.findIndex((value) => value !== SUCCESS_RESULT);
  if (unexpectedResultIndex >= 0) {
    const result = resultWrites[unexpectedResultIndex] ?? FAILURE_RESULT;
    if (result === FAILURE_RESULT) {
      throw new Error(
        `${label} result write ${unexpectedResultIndex + 1} reported a ` +
          `${reference.description} mismatch.`,
      );
    }
    throw new Error(
      `${label} result write ${unexpectedResultIndex + 1} contained unexpected ` +
        `${formatScreenCode(result)}.`,
    );
  }

  const borderColor = memory.read(BORDER_COLOR_ADDRESS) & COLOR_MASK;
  if (borderColor !== SUCCESS_BORDER_COLOR) {
    throw new Error(
      `${label} result was successful but border color is ${borderColor}; ` +
        `expected ${SUCCESS_BORDER_COLOR}.`,
    );
  }

  return {
    bootFrames,
    resultWrites,
    resultFrames,
    screenSummary: validateScreenSamples(memory, reference),
  };
}

async function main(): Promise<void> {
  const argumentsProvided = process.argv.slice(2);
  if (argumentsProvided.length > 1) {
    throw new Error('CIA TOD verifier accepts at most one target argument.');
  }
  const targetArgument = argumentsProvided[0];
  if (
    targetArgument !== undefined &&
    targetArgument !== FIX_TSEC_ONLY_ARGUMENT &&
    targetArgument !== ALARM_COND_ONLY_ARGUMENT
  ) {
    throw new Error(`Unknown CIA TOD verifier argument: ${targetArgument}.`);
  }
  const references =
    targetArgument === FIX_TSEC_ONLY_ARGUMENT
      ? CIA_TOD_REFERENCES.filter((reference) => reference.fileName === 'fix-tsec.prg')
      : targetArgument === ALARM_COND_ONLY_ARGUMENT
        ? CIA_TOD_REFERENCES.filter(
            (reference) =>
              reference.fileName === 'alarm-cond.prg' || reference.fileName === 'alarm-cond2.prg',
          )
        : CIA_TOD_REFERENCES;
  const [firmware, ...programs] = await Promise.all([
    loadFirmware(),
    ...references.map(loadReferenceProgram),
  ]);

  let completedRuns = 0;
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const program = programs[index];
    if (!reference || !program) {
      throw new Error(`Missing CIA TOD reference at index ${index}.`);
    }
    const startModes = reference.exhaustiveMatrix
      ? START_MODES
      : ([PRG_START_MODE.direct] as const);
    const models = reference.exhaustiveMatrix ? CIA_MODELS : ([MOS_6526_MODEL.original] as const);
    for (const startMode of startModes) {
      for (const model of models) {
        const result = runReference(firmware, reference, program, startMode, model);
        const source = reference.exhaustiveMatrix
          ? `commit ${FIXED_TEST_COMMIT}`
          : `revision ${UPSTREAM_TEST_REVISION}`;
        const screenSummary =
          result.screenSummary === undefined ? '' : `, samples ${result.screenSummary}`;
        const resultSummary = result.resultWrites.map(formatScreenCode).join(', ');
        console.log(
          `PASS ${reference.fileName} ${source} (${startMode}, ${model}): ` +
            `${reference.description}, BASIC READY in ${result.bootFrames} PAL frames, ` +
            `results [${resultSummary}] in ${result.resultFrames} frames${screenSummary}.`,
        );
        completedRuns += 1;
      }
    }
  }

  console.log(
    `PASS CIA TOD suite revision ${UPSTREAM_TEST_REVISION}, fixed-test commit ` +
      `${FIXED_TEST_COMMIT}: ${completedRuns} fixed-hash runs across ` +
      `${references.length} programs.`,
  );
}

await main();
