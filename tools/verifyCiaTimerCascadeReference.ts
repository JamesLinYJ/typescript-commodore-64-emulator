// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA 定时器级联外部参考验证器
//
//   文件:       verifyCiaTimerCascadeReference.ts
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
import { MOS_6526_MODEL, type Mos6526Model } from '../src/devices/Mos6526Model';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

const UPSTREAM_TEST_COMMIT = 'ef8e8efe52f3d43df7acefad132c6506239bddee';
const UPSTREAM_DIRECTORY = 'CIA/CIA-AcountsB';
const REFERENCES = [
  {
    cachePath: resolve('output/reference/cia-b-counts-original.prg'),
    fileName: 'cmp-b-counts-a-old.prg',
    model: MOS_6526_MODEL.original,
    sha256: '7ab815d29399fe202313f532d56c11a9289b6078c472965e486bfc28b9a241c8',
  },
  {
    cachePath: resolve('output/reference/cia-b-counts-revised.prg'),
    fileName: 'cmp-b-counts-a-new.prg',
    model: MOS_6526_MODEL.revised,
    sha256: 'b2ce178cdfa3b5bcd25dac66605779630c5652cae8af5094abc167d2a69e76e0',
  },
] as const;
const BASIC_BOOT_FRAME_LIMIT = 300;
const PROGRAM_ENTRY_ADDRESS = 0x080d;
const RESULT_ADDRESS = 0xd7ff;
const RESULT_FRAME_LIMIT = 600;
const SUCCESS_BORDER_COLOR = 5;
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

function formatScreen(memory: C64Memory): string {
  return Array.from({ length: 25 }, (_unused, row) => {
    const values = memory.copyRam(0x0400 + row * 40, 40);
    return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
  }).join(' ');
}

function runReference(
  firmware: C64Firmware,
  program: Uint8Array,
  fileName: string,
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

  if (cpu.isJammed) throw new Error(`${fileName} entered the 6510 JAM state (${model}).`);
  if (result !== SUCCESS_RESULT) {
    throw new Error(
      `${fileName} returned ${result === undefined ? 'no result' : `$${result.toString(16).padStart(2, '0')}`} ` +
        `within ${RESULT_FRAME_LIMIT} PAL frames (${model}); screen=${formatScreen(memory)}.`,
    );
  }

  const borderColor = memory.read(0xd020) & 0x0f;
  if (borderColor !== SUCCESS_BORDER_COLOR) {
    throw new Error(`${fileName} reported success with border ${borderColor} (${model}).`);
  }
  return { bootFrames, resultFrames };
}

const firmware = await loadFirmware();
for (const reference of REFERENCES) {
  const program = await loadReferenceProgram(reference);
  const result = runReference(firmware, program, reference.fileName, reference.model);
  console.log(
    `PASS ${reference.fileName} commit ${UPSTREAM_TEST_COMMIT} (${reference.model}): ` +
      `BASIC READY in ${result.bootFrames} PAL frames, result in ${result.resultFrames} frames.`,
  );
}
