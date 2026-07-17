// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - EasyFlash 官方程序参考验证器
//
//   文件:       verifyEasyFlashReference.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { unzipSync } from 'fflate';

import { hasBasicReadyPrompt } from '../src/core/basicStartup';
import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { AMD_29F040B_FLASH_LAYOUT } from '../src/core/memory/Amd29F040BFlash';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { EasyFlashCartridge } from '../src/core/memory/EasyFlashCartridge';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

const EASY_PROG_VERSION = '1.6.3';
const EASY_PROG_ARCHIVE = `easyprog-${EASY_PROG_VERSION}.zip`;
const EASY_PROG_ARCHIVE_SHA256 = '45f6ddc36504312d7de4b13b1d7b75f33c60cbbea10311a9a0de93b3e33c6df1';
const EASY_PROG_ARCHIVE_URL = `https://skoe.de/easyflash/files/easyprog/${EASY_PROG_ARCHIVE}`;
const EASY_PROG_ENTRY = `easyprog-${EASY_PROG_VERSION}/easyprog-${EASY_PROG_VERSION}.prg`;
const EASY_PROG_SHA256 = '2866553213bb419ea1ae54aaf750e910ae3a1934f870079ea43eab8aefb87536';
const CACHE_PATH = resolve(`output/reference/easyflash/${EASY_PROG_ARCHIVE}`);

const BASIC_BOOT_FRAME_LIMIT = 300;
const EASY_PROG_ABOUT_FRAME_LIMIT = 600;
const EASY_PROG_READY_FRAME_LIMIT = 300;
const EASY_PROG_DIALOG_FRAME_LIMIT = 80;
const EASY_PROG_FLASH_WRITE_FRAME_LIMIT = 800;
const KEY_HOLD_FRAMES = 3;
const KEY_RELEASE_FRAMES = 20;
const POST_PROGRAM_OBSERVATION_FRAMES = 20;
const MINIMUM_PROGRAMMED_BYTES_PER_CHIP = 0x100;
const SCREEN_START = 0x0400;
const SCREEN_COLUMNS = 40;
const SCREEN_ROWS = 25;

interface EasyProgRunResult {
  readonly bootFrames: number;
  readonly changedHighBytes: number;
  readonly changedLowBytes: number;
  readonly initializationFrames: number;
  readonly programmingFrames: number;
}

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

async function readCachedArchive(): Promise<Uint8Array | undefined> {
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

function validateHash(bytes: Uint8Array, expected: string, label: string): void {
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`${label} SHA-256 mismatch: received ${actual}.`);
}

async function loadEasyProg(): Promise<Uint8Array> {
  let archive = await readCachedArchive();
  if (archive) {
    validateHash(archive, EASY_PROG_ARCHIVE_SHA256, `Cached ${EASY_PROG_ARCHIVE}`);
  } else {
    const response = await fetch(EASY_PROG_ARCHIVE_URL);
    if (!response.ok) {
      throw new Error(`Unable to download EasyProg: HTTP ${response.status}.`);
    }
    archive = new Uint8Array(await response.arrayBuffer());
    validateHash(archive, EASY_PROG_ARCHIVE_SHA256, EASY_PROG_ARCHIVE_URL);
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, archive);
  }

  const files = unzipSync(archive);
  const program = files[EASY_PROG_ENTRY];
  if (!program) throw new Error(`EasyProg archive does not contain ${EASY_PROG_ENTRY}.`);
  validateHash(program, EASY_PROG_SHA256, EASY_PROG_ENTRY);
  return program;
}

function createBlankFlash(): Uint8Array {
  return new Uint8Array(AMD_29F040B_FLASH_LAYOUT.capacityBytes).fill(0xff);
}

function runEasyProg(firmware: C64Firmware, program: Uint8Array): EasyProgRunResult {
  // EasyFlash 的物理 jumper 使空白卡带在上电时保持 C64 模式，程序随后显式控制模式线。
  const cartridge = new EasyFlashCartridge({
    flashHigh: createBlankFlash(),
    flashLow: createBlankFlash(),
    jumperInstalled: true,
  });
  const memory = new C64Memory(firmware, { cartridge });
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = bootToBasicReady(scheduler, memory, cpu);

  installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.basicRun });
  const aboutFrames = waitForScreenText(
    scheduler,
    memory,
    cpu,
    `VERSION ${EASY_PROG_VERSION}`,
    EASY_PROG_ABOUT_FRAME_LIMIT,
  );
  pressKey(scheduler, memory, cpu, 'Enter');
  const readyFrames = waitForScreenText(
    scheduler,
    memory,
    cpu,
    'READY. PRESS <M> FOR MENU.',
    EASY_PROG_READY_FRAME_LIMIT,
  );

  const initializedScreen = screenText(memory);
  requireScreenText(initializedScreen, 'FLASH DRIVER:');
  requireScreenText(initializedScreen, 'AM/M29F040 V1.4');
  requireScreenText(initializedScreen, 'SLOTS:');
  requireScreenText(initializedScreen, '1 * 1024 KIBYTE');

  pressKey(scheduler, memory, cpu, 'KeyE');
  waitForScreenText(scheduler, memory, cpu, 'TORTURE TEST', EASY_PROG_DIALOG_FRAME_LIMIT);
  pressKey(scheduler, memory, cpu, 'KeyT');
  waitForScreenText(
    scheduler,
    memory,
    cpu,
    'THIS WILL ERASE THE CURRENT',
    EASY_PROG_DIALOG_FRAME_LIMIT,
  );
  pressKey(scheduler, memory, cpu, 'Enter');
  waitForScreenText(
    scheduler,
    memory,
    cpu,
    'THIS TEST RUNS ENDLESSLY.',
    EASY_PROG_DIALOG_FRAME_LIMIT,
  );
  pressKey(scheduler, memory, cpu, 'Enter');

  let programmingFrames = 0;
  for (let frame = 1; frame <= EASY_PROG_FLASH_WRITE_FRAME_LIMIT; frame += 1) {
    runFrame(scheduler, cpu);
    programmingFrames = frame;
    const currentScreen = screenText(memory);
    if (currentScreen.includes('TEST FAILED')) {
      throw new Error(`EasyProg torture test reported failure:\n${currentScreen}`);
    }
    if (cartridge.flashLow.dirty && cartridge.flashHigh.dirty) {
      runFrames(scheduler, cpu, POST_PROGRAM_OBSERVATION_FRAMES);
      break;
    }
  }
  if (!cartridge.flashLow.dirty || !cartridge.flashHigh.dirty) {
    throw new Error(
      `EasyProg did not program both AM29F040B chips within ` +
        `${EASY_PROG_FLASH_WRITE_FRAME_LIMIT} PAL frames.`,
    );
  }

  const changedLowBytes = countProgrammedBytes(cartridge.flashLow.toBytes());
  const changedHighBytes = countProgrammedBytes(cartridge.flashHigh.toBytes());
  if (
    changedLowBytes < MINIMUM_PROGRAMMED_BYTES_PER_CHIP ||
    changedHighBytes < MINIMUM_PROGRAMMED_BYTES_PER_CHIP
  ) {
    throw new Error(
      `EasyProg changed only ${changedLowBytes} ROML and ${changedHighBytes} ROMH bytes; ` +
        `expected at least ${MINIMUM_PROGRAMMED_BYTES_PER_CHIP} in each chip.`,
    );
  }

  return {
    bootFrames,
    changedHighBytes,
    changedLowBytes,
    initializationFrames: aboutFrames + readyFrames,
    programmingFrames,
  };
}

function bootToBasicReady(scheduler: PalFrameScheduler, memory: C64Memory, cpu: Cpu6502): number {
  let readyWasAbsent = !hasBasicReadyPrompt(memory);
  for (let frame = 1; frame <= BASIC_BOOT_FRAME_LIMIT; frame += 1) {
    runFrame(scheduler, cpu);
    const ready = hasBasicReadyPrompt(memory);
    if (!ready) readyWasAbsent = true;
    else if (readyWasAbsent) return frame;
  }
  throw new Error(`C64 BASIC did not reach READY within ${BASIC_BOOT_FRAME_LIMIT} PAL frames.`);
}

function waitForScreenText(
  scheduler: PalFrameScheduler,
  memory: C64Memory,
  cpu: Cpu6502,
  expected: string,
  frameLimit: number,
): number {
  for (let frame = 1; frame <= frameLimit; frame += 1) {
    runFrame(scheduler, cpu);
    if (screenText(memory).includes(expected)) return frame;
  }
  throw new Error(
    `EasyProg did not display "${expected}" within ${frameLimit} PAL frames:\n${screenText(memory)}`,
  );
}

function pressKey(
  scheduler: PalFrameScheduler,
  memory: C64Memory,
  cpu: Cpu6502,
  code: string,
): void {
  if (!memory.cia1.keyboard.setKeyState(code, true)) {
    throw new Error(`EasyProg verifier requested unsupported C64 key ${code}.`);
  }
  try {
    runFrames(scheduler, cpu, KEY_HOLD_FRAMES);
  } finally {
    memory.cia1.keyboard.setKeyState(code, false);
  }
  runFrames(scheduler, cpu, KEY_RELEASE_FRAMES);
}

function runFrames(scheduler: PalFrameScheduler, cpu: Cpu6502, frames: number): void {
  for (let frame = 0; frame < frames; frame += 1) runFrame(scheduler, cpu);
}

function runFrame(scheduler: PalFrameScheduler, cpu: Cpu6502): void {
  scheduler.runFrame();
  if (cpu.isJammed) throw new Error('EasyProg entered the 6510 JAM state.');
}

function screenText(memory: C64Memory): string {
  const lines: string[] = [];
  for (let row = 0; row < SCREEN_ROWS; row += 1) {
    let line = '';
    for (let column = 0; column < SCREEN_COLUMNS; column += 1) {
      line += screenCodeToAscii(memory.ram[SCREEN_START + row * SCREEN_COLUMNS + column]);
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function screenCodeToAscii(value: number): string {
  const code = value & 0x7f;
  if (code === 0x20) return ' ';
  if (code >= 0x01 && code <= 0x1a) return String.fromCharCode(0x40 + code);
  if (code >= 0x21 && code <= 0x3f) return String.fromCharCode(code);
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code);
  return '.';
}

function requireScreenText(screen: string, expected: string): void {
  if (screen.includes(expected)) return;
  throw new Error(`EasyProg screen is missing "${expected}":\n${screen}`);
}

function countProgrammedBytes(bytes: Uint8Array): number {
  let count = 0;
  for (const value of bytes) if (value !== 0xff) count += 1;
  return count;
}

async function main(): Promise<void> {
  const [firmware, program] = await Promise.all([loadFirmware(), loadEasyProg()]);
  const result = runEasyProg(firmware, program);
  console.log(
    `PASS official EasyProg ${EASY_PROG_VERSION}: BASIC READY in ${result.bootFrames} frames, ` +
      `AM29F040 V1.4 and 1 MiB cartridge detected in ${result.initializationFrames} frames; ` +
      `its 6510 torture path programmed ${result.changedLowBytes} ROML and ` +
      `${result.changedHighBytes} ROMH bytes after ${result.programmingFrames} PAL frames.`,
  );
}

await main();
