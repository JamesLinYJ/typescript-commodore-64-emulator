// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 内置 PRG 整机兼容验证器
//
//   文件:       verifyBundledPrograms.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { hasBasicReadyPrompt } from '../src/core/basicStartup';
import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import {
  BUNDLED_PROGRAMS,
  type BundledProgramDescriptor,
} from '../src/media/BundledProgramCatalog';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PAL_VIDEO_STANDARD } from '../src/video/palVideoStandard';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';
import { PixelFrameBuffer } from '../src/video/PixelFrameBuffer';

interface ProgramExecutionMetrics {
  readonly changedPixels: number;
  readonly instructionCount: number;
  readonly ioWriteCount: number;
  readonly ramInstructionCount: number;
  readonly screenWriteCount: number;
  readonly uniqueProgramCounters: number;
}

const BASIC_BOOT_FRAME_LIMIT = 300;
const PROGRAM_EXECUTION_FRAME_COUNT = 180;
const VISUAL_SAMPLE_FRAMES = new Set([30, 60, 120, PROGRAM_EXECUTION_FRAME_COUNT]);

const COMPATIBILITY_MINIMUM = {
  changedPixels: 1_000,
  instructionCount: 100_000,
  ioWriteCount: 100,
  ramInstructionCount: 10_000,
  screenWriteCount: 500,
  uniqueProgramCounters: 400,
} as const;

const C64_SCREEN_MEMORY = {
  endExclusive: 0x07e8,
  start: 0x0400,
} as const;
const C64_IO_WINDOW = {
  endExclusive: 0xe000,
  start: 0xd000,
} as const;

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

async function loadProgram(program: BundledProgramDescriptor): Promise<Uint8Array> {
  const bytes = await readBinary(`public/programs/${program.file}`);
  const actualHash = sha256(bytes);
  if (actualHash !== program.sha256) {
    throw new Error(
      `Bundled PRG ${program.file} SHA-256 mismatch: received ${actualHash}, expected ${program.sha256}.`,
    );
  }
  return bytes;
}

function captureFrame(
  scheduler: PalFrameScheduler,
  memory: C64Memory,
  frameBuffer: PixelFrameBuffer,
): void {
  const { firstVisibleRaster, lastVisibleRasterExclusive } = PAL_VIDEO_STANDARD.output;
  frameBuffer.clear(memory.vic.palette[0]);
  scheduler.runFrame((rasterLine) => {
    if (rasterLine < firstVisibleRaster || rasterLine >= lastVisibleRasterExclusive) return;
    memory.vic.copyRasterLinePixelsTo(
      frameBuffer.pixels,
      (rasterLine - firstVisibleRaster) * frameBuffer.width,
    );
  });
}

function bootToBasicReady(
  scheduler: PalFrameScheduler,
  memory: C64Memory,
  frameBuffer: PixelFrameBuffer,
): void {
  let readyWasAbsent = !hasBasicReadyPrompt(memory);
  for (let frame = 0; frame < BASIC_BOOT_FRAME_LIMIT; frame += 1) {
    captureFrame(scheduler, memory, frameBuffer);
    const ready = hasBasicReadyPrompt(memory);
    if (!ready) readyWasAbsent = true;
    else if (readyWasAbsent) return;
  }
  throw new Error(`C64 BASIC did not reach READY within ${BASIC_BOOT_FRAME_LIMIT} PAL frames.`);
}

function countChangedPixels(before: Uint32Array, after: Uint32Array): number {
  if (before.length !== after.length) {
    throw new RangeError(
      `Cannot compare pixel frames of ${before.length} and ${after.length} pixels.`,
    );
  }
  let changed = 0;
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) changed += 1;
  }
  return changed;
}

function isRamExecutionAddress(address: number): boolean {
  return address < 0xa000 || (address >= 0xc000 && address < 0xd000);
}

function isAddressInRange(
  address: number,
  range: { readonly start: number; readonly endExclusive: number },
): boolean {
  return address >= range.start && address < range.endExclusive;
}

function assertMinimum(
  program: BundledProgramDescriptor,
  metric: keyof ProgramExecutionMetrics,
  actual: number,
): void {
  const expected = COMPATIBILITY_MINIMUM[metric];
  if (actual < expected) {
    throw new Error(
      `${program.title} produced ${actual} ${metric}; expected at least ${expected} after ` +
        `${PROGRAM_EXECUTION_FRAME_COUNT} PAL frames.`,
    );
  }
}

function verifyProgramExecution(
  firmware: C64Firmware,
  program: BundledProgramDescriptor,
  bytes: Uint8Array,
): ProgramExecutionMetrics {
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const frameBuffer = new PixelFrameBuffer(
    PAL_VIDEO_STANDARD.output.width,
    PAL_VIDEO_STANDARD.output.height,
  );
  bootToBasicReady(scheduler, memory, frameBuffer);
  const basicReadyPixels = frameBuffer.pixels.slice();

  let instructionCount = 0;
  let ramInstructionCount = 0;
  let ioWriteCount = 0;
  let screenWriteCount = 0;
  let changedPixels = 0;
  const programCounters = new Set<number>();

  cpu.setInstructionObserver((address) => {
    instructionCount += 1;
    programCounters.add(address);
    if (isRamExecutionAddress(address)) ramInstructionCount += 1;
  });
  const stopObservingWrites = memory.observeWrites(({ address }) => {
    if (isAddressInRange(address, C64_IO_WINDOW)) ioWriteCount += 1;
    if (isAddressInRange(address, C64_SCREEN_MEMORY)) screenWriteCount += 1;
  });

  try {
    installPrg(parsePrg(bytes), memory, cpu, { startMode: PRG_START_MODE.basicRun });
    for (let frame = 1; frame <= PROGRAM_EXECUTION_FRAME_COUNT; frame += 1) {
      captureFrame(scheduler, memory, frameBuffer);
      if (cpu.isJammed) {
        throw new Error(`${program.title} entered the 6510 JAM state at PAL frame ${frame}.`);
      }
      if (VISUAL_SAMPLE_FRAMES.has(frame)) {
        changedPixels = Math.max(
          changedPixels,
          countChangedPixels(basicReadyPixels, frameBuffer.pixels),
        );
      }
    }
  } finally {
    stopObservingWrites();
    cpu.setInstructionObserver(undefined);
  }

  const metrics: ProgramExecutionMetrics = {
    changedPixels,
    instructionCount,
    ioWriteCount,
    ramInstructionCount,
    screenWriteCount,
    uniqueProgramCounters: programCounters.size,
  };
  for (const metric of Object.keys(metrics) as (keyof ProgramExecutionMetrics)[]) {
    assertMinimum(program, metric, metrics[metric]);
  }
  if ((memory.ram[0x00c6] ?? 0) !== 0) {
    throw new Error(`${program.title} did not consume the BASIC keyboard command buffer.`);
  }
  return metrics;
}

async function main(): Promise<void> {
  const firmware = await loadFirmware();
  for (const program of BUNDLED_PROGRAMS) {
    const bytes = await loadProgram(program);
    const metrics = verifyProgramExecution(firmware, program, bytes);
    console.log(
      `PASS ${program.title}: ${metrics.instructionCount.toLocaleString('en-US')} instructions, ` +
        `${metrics.uniqueProgramCounters.toLocaleString('en-US')} PCs, ` +
        `${metrics.changedPixels.toLocaleString('en-US')} changed pixels.`,
    );
  }
  console.log(
    `PASS bundled PRG compatibility: ${BUNDLED_PROGRAMS.length} programs, ` +
      `${PROGRAM_EXECUTION_FRAME_COUNT} PAL frames each.`,
  );
}

await main();
