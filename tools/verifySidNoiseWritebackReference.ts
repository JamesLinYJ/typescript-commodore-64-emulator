import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { hasBasicReadyPrompt } from '../src/core/basicStartup';
import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { SID_MODEL, type SidModel } from '../src/devices/SidModel';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

const REVISION = 46_176;
const ROOT = `https://sourceforge.net/p/vice-emu/code/${REVISION}/tree/testprogs/SID`;
const MATRIX = [0xff, 0xfe, 0xfc, 0xfc, 0xfc, 0xf8, 0xf8, 0xf8, 0xf8, 0xf0, 0xf0];

interface Reference {
  readonly cache: string;
  readonly directory: string;
  readonly file: string;
  readonly sha256: string;
}
interface Case {
  readonly expected: readonly number[];
  readonly label: string;
  readonly model: SidModel;
  readonly reference: Reference;
}

const test1 = {
  cache: 'output/reference/sid-noise-writeback-test1.prg',
  directory: 'noisewriteback',
  file: 'noise_writeback_test1-old.prg',
  sha256: '4f85095b30b9b32260d0e993d03ba67bcdb215ac9bbb9b26ab922638ba7f93dc',
} as const;
const test2Old = {
  cache: 'output/reference/sid-noise-writeback-test2-old.prg',
  directory: 'noisewriteback',
  file: 'noise_writeback_test2-old.prg',
  sha256: '9ee3ac86b997d65bbf7b6126a1ae336def638e754724fd9843320ef9b34d3b94',
} as const;
const test2New = {
  cache: 'output/reference/sid-noise-writeback-test2-new.prg',
  directory: 'noisewriteback',
  file: 'noise_writeback_test2-new.prg',
  sha256: '39429fd6fd47e436b40adadac2fd2b65baf5a9c0ae616ddb090fbb17aee86e9e',
} as const;
const matrix8 = {
  cache: 'output/reference/sid-noise-writeback-8-to-8.prg',
  directory: 'wb_testsuite',
  file: 'noise_writeback_check_8_to_8_old.prg',
  sha256: '87c8204509171302e7ff6730ff07b06f3291cf11c6fa9aa9e49faba18db63f08',
} as const;
const matrix9 = {
  cache: 'output/reference/sid-noise-writeback-9-to-8.prg',
  directory: 'wb_testsuite',
  file: 'noise_writeback_check_9_to_8_old.prg',
  sha256: '6bd27be17f983a5501df1671ffe3bf6ba0b3741d6cc9849a8fda65f07bc70a68',
} as const;
const cases: readonly Case[] = [
  { expected: [0xfe, 0xfe], label: 'test1-old', model: SID_MODEL.mos6581, reference: test1 },
  { expected: [0xfe, 0xfe], label: 'test1-new', model: SID_MODEL.mos8580, reference: test1 },
  { expected: [0x00, 0x14], label: 'test2-old', model: SID_MODEL.mos6581, reference: test2Old },
  { expected: [0x00, 0x12], label: 'test2-new', model: SID_MODEL.mos8580, reference: test2New },
  { expected: MATRIX, label: '8-to-8-old', model: SID_MODEL.mos6581, reference: matrix8 },
  { expected: MATRIX, label: '8-to-8-new', model: SID_MODEL.mos8580, reference: matrix8 },
  { expected: MATRIX, label: '9-to-8-old', model: SID_MODEL.mos6581, reference: matrix9 },
  { expected: MATRIX, label: '9-to-8-new', model: SID_MODEL.mos8580, reference: matrix9 },
];

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(path)));
}
async function load(reference: Reference): Promise<Uint8Array> {
  let data: Uint8Array;
  try {
    data = await bytes(reference.cache);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    const response = await fetch(`${ROOT}/${reference.directory}/${reference.file}?format=raw`);
    if (!response.ok)
      throw new Error(`Unable to download ${reference.file}: HTTP ${response.status}.`, {
        cause: error,
      });
    data = new Uint8Array(await response.arrayBuffer());
    await mkdir(dirname(reference.cache), { recursive: true });
    await writeFile(reference.cache, data);
  }
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== reference.sha256)
    throw new Error(`${reference.file} SHA-256 mismatch: ${actual}.`);
  return data;
}
function boot(scheduler: PalFrameScheduler, memory: C64Memory): number {
  let absent = !hasBasicReadyPrompt(memory);
  for (let frame = 1; frame <= 300; frame += 1) {
    scheduler.runFrame();
    const ready = hasBasicReadyPrompt(memory);
    if (!ready) absent = true;
    else if (absent) return frame;
  }
  throw new Error('C64 BASIC did not reach READY.');
}
function run(firmware: C64Firmware, test: Case, program: Uint8Array): string {
  const memory = new C64Memory(firmware, { sidModel: test.model });
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = boot(scheduler, memory);
  installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.none });
  cpu.pc = 0x080d;
  let result: number | undefined;
  const stop = memory.observeWrites(({ address, value }) => {
    if (address === 0xd7ff) result ??= value;
  });
  let resultFrames = 0;
  try {
    for (let frame = 1; frame <= 1_000; frame += 1) {
      scheduler.runFrame(undefined, true);
      if (result !== undefined || cpu.isJammed) {
        resultFrames = frame;
        break;
      }
    }
  } finally {
    stop();
  }
  const actual = [...memory.copyRam(0x0400, test.expected.length)];
  if (
    cpu.isJammed ||
    result !== 0 ||
    actual.some((value, index) => value !== test.expected[index])
  ) {
    throw new Error(
      `${test.label}/${test.model} failed: result=${String(result)}, OSC3=${actual.map((value) => value.toString(16).padStart(2, '0')).join(' ')}.`,
    );
  }
  return `${test.label}/${test.model} (${bootFrames}+${resultFrames} frames)`;
}

const firmware: C64Firmware = {
  basic: await bytes('public/firmware/basic.901226-01.bin'),
  character: await bytes('public/firmware/characters.901225-01.bin'),
  kernal: await bytes('public/firmware/kernal.901227-03.bin'),
};
const references = [...new Set(cases.map((test) => test.reference))];
const programs = new Map(
  await Promise.all(
    references.map(async (reference) => [reference, await load(reference)] as const),
  ),
);
console.log(
  `PASS SID noise writeback revision ${REVISION}: ${cases.map((test) => run(firmware, test, programs.get(test.reference)!)).join('; ')}.`,
);
