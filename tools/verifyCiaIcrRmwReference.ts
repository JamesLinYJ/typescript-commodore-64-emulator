// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA ICR 读改写外部参考验证器
//
//   文件:       verifyCiaIcrRmwReference.ts
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
const REFERENCE = {
  cachePath: resolve('output/reference/cia-dd0dtest.prg'),
  fileName: 'dd0dtest.prg',
  sha256: '9d8bf7079b14f03a76eaed1ffe28992055e7728dafc79e0711af2b7378454e46',
  url:
    `https://sourceforge.net/p/vice-emu/code/${UPSTREAM_TEST_REVISION}/tree/` +
    'testprogs/CIA/dd0dtest/dd0dtest.prg?format=raw',
} as const;
const BASIC_BOOT_FRAME_LIMIT = 300;
const PROGRAM_ENTRY_ADDRESS = 0x080d;
const RESULT_ADDRESS = 0xd7ff;
const RESULT_FRAME_LIMIT = 800;
const SUCCESS_RESULT = 0x00;

async function readBinary(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(path)));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function loadProgram(): Promise<Uint8Array> {
  try {
    const cached = await readBinary(REFERENCE.cachePath);
    const actualHash = sha256(cached);
    if (actualHash !== REFERENCE.sha256) {
      throw new Error(`Cached ${REFERENCE.fileName} SHA-256 mismatch: received ${actualHash}.`);
    }
    return cached;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) throw error;
  }

  const response = await fetch(REFERENCE.url);
  if (!response.ok) {
    throw new Error(`Unable to download ${REFERENCE.fileName}: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const actualHash = sha256(downloaded);
  if (actualHash !== REFERENCE.sha256) {
    throw new Error(`Downloaded ${REFERENCE.fileName} SHA-256 mismatch: received ${actualHash}.`);
  }
  await mkdir(dirname(REFERENCE.cachePath), { recursive: true });
  await writeFile(REFERENCE.cachePath, downloaded);
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

function formatScreen(memory: C64Memory): string {
  return Array.from({ length: 25 }, (_unused, row) => {
    const values = memory.copyRam(0x0400 + row * 40, 40);
    return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
  }).join(' ');
}

function runReference(
  firmware: C64Firmware,
  program: Uint8Array,
  model: Mos6526Model,
): { readonly bootFrames: number; readonly resultFrames: number } {
  const memory = new C64Memory(firmware, { ciaModels: { cia1: model, cia2: model } });
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = bootToBasicReady(scheduler, memory);

  installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.none });
  cpu.pc = PROGRAM_ENTRY_ADDRESS;
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

  if (cpu.isJammed) throw new Error(`${REFERENCE.fileName} entered the 6510 JAM state (${model}).`);
  if (result === undefined) {
    throw new Error(
      `${REFERENCE.fileName} did not report within ${RESULT_FRAME_LIMIT} PAL frames (${model}).`,
    );
  }
  if (result !== SUCCESS_RESULT) {
    throw new Error(
      `${REFERENCE.fileName} failed with $${result.toString(16).padStart(2, '0')} (${model}); ` +
        `screen=${formatScreen(memory)}.`,
    );
  }
  return { bootFrames, resultFrames };
}

const [firmware, program] = await Promise.all([loadFirmware(), loadProgram()]);
for (const model of [MOS_6526_MODEL.original, MOS_6526_MODEL.revised] as const) {
  const result = runReference(firmware, program, model);
  console.log(
    `PASS ${REFERENCE.fileName} revision ${UPSTREAM_TEST_REVISION} (${model}): ` +
      `BASIC READY in ${result.bootFrames} PAL frames, result in ${result.resultFrames} frames.`,
  );
}
