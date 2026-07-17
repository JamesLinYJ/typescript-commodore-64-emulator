// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Datasette KERNAL 装载参考验证
//
//   文件:       verifyDatasetteReference.ts
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
import { parseTapImage } from '../src/media/TapImageParser';
import { WritableTapImage } from '../src/media/WritableTapImage';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';
import { createCommodoreRomTapeFixture } from './reference/CommodoreRomTapeFixture';

const BASIC_BOOT_FRAME_LIMIT = 300;
const BASIC_LINE_ENTRY_FRAME_LIMIT = 300;
const TAPE_LOAD_FRAME_LIMIT = 1_800;
const TAPE_SAVE_FRAME_LIMIT = 1_800;
const VICE_TAPE_WRITE_FRAME_LIMIT = 300;
const C64_KEYBOARD_BUFFER = {
  capacityAddress: 0x0289,
  countAddress: 0x00c6,
  start: 0x0277,
} as const;
const C64_SCREEN_MEMORY = {
  endExclusive: 0x07e8,
  spaceCharacter: 0x20,
  start: 0x0400,
} as const;
const KERNAL_IO_STATUS_ADDRESS = 0x0090;
const KERNAL_LOAD_END_ADDRESS_POINTER = 0x00ae;
const BASIC_TEXT_END_POINTER = 0x002d;
const BASIC_PROGRAM_START_ADDRESS = 0x0801;
const EXPECTED_TAP_SHA256 = '72434c68f55b078e9cabca5e6db55273c9fbf87f98d668d93c681bb65958f731';
const EXPECTED_KERNAL_SAVE_TAP_SHA256 =
  'c7503b92224d157bd1ba05fa0b1c100a8ddca6c9ea679ec52a2dc517abcead02';
const TAPE_FILE = {
  fileName: 'CODEX TAPE',
  loadAddress: 0xc000,
  payload: Uint8Array.from({ length: 64 }, (_, index) => (index * 73 + 0x35) & 0xff),
} as const;
const LOAD_TAPE_COMMAND = petsciiCommand(`LOAD"${TAPE_FILE.fileName}",1,1`);
const TAPE_SAVE_FILE_NAME = 'CODEX SAVE';
const ENTER_SAVE_PROGRAM_COMMAND = petsciiCommand('10 PRINT"CODEX"');
const SAVE_TAPE_COMMAND = petsciiCommand(`SAVE"${TAPE_SAVE_FILE_NAME}",1`);
const LOAD_SAVED_TAPE_COMMAND = petsciiCommand(`LOAD"${TAPE_SAVE_FILE_NAME}",1`);
// BASIC V2 对 10 PRINT"CODEX" 的固定 token 化结果；完整 PRG 是独立于待测 RAM 的预言机。
const EXPECTED_SAVED_BASIC_FILE = Uint8Array.of(
  0x01,
  0x08, // PRG load address $0801
  0x0e,
  0x08, // 下一行指针 $080E
  0x0a,
  0x00, // BASIC line number 10
  0x99, // PRINT token
  0x22,
  0x43,
  0x4f,
  0x44,
  0x45,
  0x58,
  0x22,
  0x00, // 行结束
  0x00,
  0x00, // 程序结束
);
const VICE_TAPE_WRITE_ASSET = {
  cachePath: resolve('output/reference/vice-testprogs/tape/tap204060/tap204060once.prg'),
  fileName: 'tap204060once.prg',
  sha256: '5311adc89f6296b9dee38166bf1b1e588c5343e7e3c8f41203b3ef1ea5e693a9',
  url: 'https://sourceforge.net/p/vice-emu/code/46176/tree/testprogs/tape/tap204060/tap204060once.prg?format=raw',
} as const;
const VICE_EXPECTED_WRITE_PULSES = [0x20 * 8, 0x40 * 8, 0x60 * 8, 0x40 * 8] as const;

interface ReferenceAsset {
  readonly cachePath: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly url: string;
}

class BasicKeyboardCommandFeeder {
  private offset = 0;

  constructor(private readonly command: Uint8Array) {}

  get finished(): boolean {
    return this.offset === this.command.length;
  }

  refill(memory: C64Memory): void {
    const used = memory.ram[C64_KEYBOARD_BUFFER.countAddress] ?? 0;
    const capacity = memory.ram[C64_KEYBOARD_BUFFER.capacityAddress] ?? 0;
    if (capacity === 0) throw new Error('C64 KERNAL keyboard buffer has zero capacity.');
    if (used > capacity) {
      throw new Error(`C64 keyboard buffer count ${used} exceeds its capacity ${capacity}.`);
    }

    const writeCount = Math.min(capacity - used, this.command.length - this.offset);
    if (writeCount === 0) return;
    memory.injectRamImage(
      C64_KEYBOARD_BUFFER.start + used,
      this.command.subarray(this.offset, this.offset + writeCount),
    );
    memory.ram[C64_KEYBOARD_BUFFER.countAddress] = used + writeCount;
    this.offset += writeCount;
  }
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

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readCachedAsset(asset: ReferenceAsset): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(asset.cachePath));
  } catch (error: unknown) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function validateAssetHash(asset: ReferenceAsset, bytes: Uint8Array, source: string): void {
  const actualHash = sha256(bytes);
  if (actualHash !== asset.sha256) {
    throw new Error(`${asset.fileName} SHA-256 mismatch for ${source}: received ${actualHash}.`);
  }
}

async function loadReferenceAsset(asset: ReferenceAsset): Promise<Uint8Array> {
  const cached = await readCachedAsset(asset);
  if (cached) {
    validateAssetHash(asset, cached, asset.cachePath);
    return cached;
  }

  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`Unable to download ${asset.fileName}: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  validateAssetHash(asset, downloaded, asset.url);
  await mkdir(dirname(asset.cachePath), { recursive: true });
  await writeFile(asset.cachePath, downloaded);
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

function runBasicCommand(
  scheduler: PalFrameScheduler,
  memory: C64Memory,
  cpu: Cpu6502,
  command: Uint8Array,
  label: string,
  frameLimit: number,
): number {
  const feeder = new BasicKeyboardCommandFeeder(command);
  memory.ram.fill(
    C64_SCREEN_MEMORY.spaceCharacter,
    C64_SCREEN_MEMORY.start,
    C64_SCREEN_MEMORY.endExclusive,
  );

  for (let frame = 1; frame <= frameLimit; frame += 1) {
    feeder.refill(memory);
    scheduler.runFrame();
    if (cpu.isJammed) throw new Error(`${label} entered the 6510 JAM state.`);

    const keyboardEmpty = (memory.ram[C64_KEYBOARD_BUFFER.countAddress] ?? 0) === 0;
    if (feeder.finished && keyboardEmpty && hasBasicReadyPrompt(memory)) return frame;
  }

  const registers = cpu.getRegisters();
  throw new Error(
    `${label} did not return within ${frameLimit} PAL frames; ` +
      `PC=$${hex(registers.programCounter, 4)}, P=$${hex(registers.status, 2)}, ` +
      `status=$${hex(memory.ram[KERNAL_IO_STATUS_ADDRESS] ?? 0, 2)}, ` +
      `motor=${String(memory.datasette.motorActive)}, pulse=${memory.datasette.pulseIndex}.`,
  );
}

function enterBasicProgramLine(
  scheduler: PalFrameScheduler,
  memory: C64Memory,
  cpu: Cpu6502,
): number {
  const feeder = new BasicKeyboardCommandFeeder(ENTER_SAVE_PROGRAM_COMMAND);
  for (let frame = 1; frame <= BASIC_LINE_ENTRY_FRAME_LIMIT; frame += 1) {
    feeder.refill(memory);
    scheduler.runFrame();
    if (cpu.isJammed) throw new Error('BASIC tape SAVE line entry entered the 6510 JAM state.');
    const keyboardEmpty = (memory.ram[C64_KEYBOARD_BUFFER.countAddress] ?? 0) === 0;
    if (feeder.finished && keyboardEmpty && basicProgramMatchesMemory(memory)) return frame;
  }
  throw new Error(
    `BASIC tape SAVE line entry did not produce the fixed tokenized program within ` +
      `${BASIC_LINE_ENTRY_FRAME_LIMIT} PAL frames.`,
  );
}

function assertLoadedPayload(memory: C64Memory): void {
  for (let offset = 0; offset < TAPE_FILE.payload.length; offset += 1) {
    const address = TAPE_FILE.loadAddress + offset;
    const actual = memory.ram[address];
    const expected = TAPE_FILE.payload[offset];
    if (actual !== expected) {
      throw new Error(
        `KERNAL tape LOAD mismatch at $${hex(address, 4)}: ` +
          `received $${hex(actual ?? 0, 2)}, expected $${hex(expected ?? 0, 2)}.`,
      );
    }
  }

  const endAddress =
    (memory.ram[KERNAL_LOAD_END_ADDRESS_POINTER] ?? 0) |
    ((memory.ram[KERNAL_LOAD_END_ADDRESS_POINTER + 1] ?? 0) << 8);
  const expectedEndAddress = TAPE_FILE.loadAddress + TAPE_FILE.payload.length;
  if (endAddress !== expectedEndAddress) {
    throw new Error(
      `KERNAL tape LOAD ended at $${hex(endAddress, 4)}; expected $${hex(expectedEndAddress, 4)}.`,
    );
  }
  const status = memory.ram[KERNAL_IO_STATUS_ADDRESS] ?? 0;
  if (status !== 0) throw new Error(`KERNAL tape LOAD returned status $${hex(status, 2)}.`);
}

function readRamWord(memory: C64Memory, address: number): number {
  return (memory.ram[address] ?? 0) | ((memory.ram[address + 1] ?? 0) << 8);
}

function basicProgramMatchesMemory(memory: C64Memory): boolean {
  const payload = EXPECTED_SAVED_BASIC_FILE.subarray(2);
  if (
    readRamWord(memory, BASIC_TEXT_END_POINTER) !==
    BASIC_PROGRAM_START_ADDRESS + payload.length
  ) {
    return false;
  }
  for (let index = 0; index < payload.length; index += 1) {
    if (memory.ram[BASIC_PROGRAM_START_ADDRESS + index] !== payload[index]) return false;
  }
  return true;
}

function assertBasicProgramInMemory(memory: C64Memory): void {
  if (!basicProgramMatchesMemory(memory)) {
    throw new Error('Tape SAVE/LOAD did not preserve the fixed tokenized BASIC program.');
  }
  const expectedEndAddress =
    BASIC_PROGRAM_START_ADDRESS + EXPECTED_SAVED_BASIC_FILE.subarray(2).length;
  const kernalEndAddress = readRamWord(memory, KERNAL_LOAD_END_ADDRESS_POINTER);
  if (kernalEndAddress !== expectedEndAddress) {
    throw new Error(
      `Saved BASIC LOAD ended at $${hex(kernalEndAddress, 4)}; ` +
        `expected $${hex(expectedEndAddress, 4)}.`,
    );
  }
  const status = memory.ram[KERNAL_IO_STATUS_ADDRESS] ?? 0;
  if (status !== 0) throw new Error(`Saved BASIC LOAD returned status $${hex(status, 2)}.`);
}

function assertPulseSequence(
  actual: readonly number[],
  expected: readonly number[],
  label: string,
): void {
  if (actual.length !== expected.length) {
    throw new Error(`${label} produced ${actual.length} pulses; expected ${expected.length}.`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] === expected[index]) continue;
    throw new Error(
      `${label} pulse ${index} lasted ${String(actual[index])} cycles; ` +
        `expected ${String(expected[index])}.`,
    );
  }
}

function verifyViceWriteWaveform(firmware: C64Firmware, program: Uint8Array): void {
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const tape = new WritableTapImage();

  try {
    bootToBasicReady(scheduler, memory);
    memory.datasette.insertTape(tape);
    memory.datasette.pressRecord();
    installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.basicRun });

    let completedFrame = 0;
    for (let frame = 1; frame <= VICE_TAPE_WRITE_FRAME_LIMIT; frame += 1) {
      scheduler.runFrame();
      if (cpu.isJammed) throw new Error('VICE tape WRITE reference entered the 6510 JAM state.');
      if (tape.pulses.length < VICE_EXPECTED_WRITE_PULSES.length + 1) continue;
      completedFrame = frame;
      break;
    }
    if (completedFrame === 0) {
      throw new Error(
        `VICE tape WRITE reference did not emit five pulses within ` +
          `${VICE_TAPE_WRITE_FRAME_LIMIT} PAL frames.`,
      );
    }

    memory.datasette.pressStop();
    const recordedCycles = tape.pulses.map(({ sourceCycles }) => sourceCycles);
    if (recordedCycles.length !== VICE_EXPECTED_WRITE_PULSES.length + 1) {
      throw new Error(
        `VICE tape WRITE reference emitted ${recordedCycles.length} pulses instead of five.`,
      );
    }
    const initialPause = recordedCycles[0];
    if (initialPause === undefined || initialPause < tape.sourceClockHz) {
      throw new Error(
        `VICE tape WRITE initial pause lasted ${String(initialPause)} cycles; expected over one second.`,
      );
    }
    assertPulseSequence(
      recordedCycles.slice(1),
      VICE_EXPECTED_WRITE_PULSES,
      'VICE tape WRITE reference',
    );
    const reparsed = parseTapImage(tape.toBytes());
    assertPulseSequence(
      reparsed.pulses.slice(1).map(({ sourceCycles }) => sourceCycles),
      VICE_EXPECTED_WRITE_PULSES,
      'Serialized VICE tape WRITE reference',
    );

    console.log(
      `PASS Commodore 1530 WRITE waveform: fixed VICE ${VICE_TAPE_WRITE_ASSET.fileName} ` +
        `completed in ${completedFrame} PAL frames; tail pulses ` +
        `${VICE_EXPECTED_WRITE_PULSES.join('/')}; SHA-256 ${VICE_TAPE_WRITE_ASSET.sha256}.`,
    );
  } finally {
    memory.datasette.disconnect();
  }
}

function verifyKernalSaveRoundTrip(firmware: C64Firmware): void {
  const saveMemory = new C64Memory(firmware);
  const saveCpu = new Cpu6502(saveMemory);
  const saveScheduler = new PalFrameScheduler(saveCpu, saveMemory);
  const writableTape = new WritableTapImage();
  let lineEntryFrames: number;
  let saveFrames: number;
  let tapBytes: Uint8Array;

  try {
    bootToBasicReady(saveScheduler, saveMemory);
    lineEntryFrames = enterBasicProgramLine(saveScheduler, saveMemory, saveCpu);
    if (!basicProgramMatchesMemory(saveMemory)) {
      throw new Error('BASIC line entry did not match the fixed tape SAVE oracle.');
    }

    saveMemory.datasette.insertTape(writableTape);
    saveMemory.datasette.pressRecord();
    saveFrames = runBasicCommand(
      saveScheduler,
      saveMemory,
      saveCpu,
      SAVE_TAPE_COMMAND,
      `KERNAL SAVE"${TAPE_SAVE_FILE_NAME}",1`,
      TAPE_SAVE_FRAME_LIMIT,
    );
    const saveStatus = saveMemory.ram[KERNAL_IO_STATUS_ADDRESS] ?? 0;
    if (saveStatus !== 0) {
      throw new Error(`KERNAL tape SAVE returned status $${hex(saveStatus, 2)}.`);
    }
    saveMemory.datasette.pressStop();
    if (writableTape.pulses.length === 0) {
      throw new Error('KERNAL tape SAVE returned without recording physical WRITE pulses.');
    }
    tapBytes = writableTape.toBytes();
  } finally {
    saveMemory.datasette.disconnect();
  }

  const recordedTape = parseTapImage(tapBytes);
  const tapHash = sha256(tapBytes);
  if (tapHash !== EXPECTED_KERNAL_SAVE_TAP_SHA256) {
    throw new Error(`KERNAL SAVE TAP SHA-256 changed to ${tapHash}.`);
  }
  if (recordedTape.pulses.length !== writableTape.pulses.length) {
    throw new Error('Serialized KERNAL SAVE TAP changed its physical pulse count.');
  }

  const loadMemory = new C64Memory(firmware);
  const loadCpu = new Cpu6502(loadMemory);
  const loadScheduler = new PalFrameScheduler(loadCpu, loadMemory);
  let loadFrames: number;
  try {
    bootToBasicReady(loadScheduler, loadMemory);
    loadMemory.ram.fill(
      0xa5,
      BASIC_PROGRAM_START_ADDRESS,
      BASIC_PROGRAM_START_ADDRESS + EXPECTED_SAVED_BASIC_FILE.length,
    );
    loadMemory.datasette.insertTape(recordedTape);
    loadMemory.datasette.pressPlay();
    loadFrames = runBasicCommand(
      loadScheduler,
      loadMemory,
      loadCpu,
      LOAD_SAVED_TAPE_COMMAND,
      `KERNAL LOAD"${TAPE_SAVE_FILE_NAME}",1`,
      TAPE_LOAD_FRAME_LIMIT,
    );
    assertBasicProgramInMemory(loadMemory);
  } finally {
    loadMemory.datasette.disconnect();
  }

  console.log(
    `PASS Commodore 1530 KERNAL SAVE/LOAD: BASIC line entered in ${lineEntryFrames} frames; ` +
      `${writableTape.pulses.length.toLocaleString('en-US')} WRITE pulses saved in ` +
      `${saveFrames} frames and loaded by a fresh machine in ${loadFrames} frames; ` +
      `TAP SHA-256 ${tapHash}.`,
  );
}

function petsciiCommand(value: string): Uint8Array {
  const command = new Uint8Array(value.length + 1);
  command.set(Uint8Array.from(value, (character) => character.charCodeAt(0)));
  command[value.length] = 0x0d;
  return command;
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

async function main(): Promise<void> {
  const [firmware, viceTapeWriteProgram] = await Promise.all([
    loadFirmware(),
    loadReferenceAsset(VICE_TAPE_WRITE_ASSET),
  ]);
  const tapBytes = createCommodoreRomTapeFixture(TAPE_FILE);
  const tapHash = sha256(tapBytes);
  if (tapHash !== EXPECTED_TAP_SHA256) {
    throw new Error(`ROM tape reference fixture SHA-256 changed to ${tapHash}.`);
  }
  const tape = parseTapImage(tapBytes);
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = bootToBasicReady(scheduler, memory);

  memory.ram.fill(0xa5, TAPE_FILE.loadAddress, TAPE_FILE.loadAddress + TAPE_FILE.payload.length);
  memory.datasette.insertTape(tape);
  memory.datasette.pressPlay();
  let readPulseCount = 0;
  const stopObservingPulses = memory.tapePort.observeReadPulses(() => {
    readPulseCount += 1;
  });

  try {
    const loadFrames = runBasicCommand(
      scheduler,
      memory,
      cpu,
      LOAD_TAPE_COMMAND,
      'KERNAL tape LOAD fixture',
      TAPE_LOAD_FRAME_LIMIT,
    );
    assertLoadedPayload(memory);
    if (readPulseCount === 0 || memory.datasette.pulseIndex === 0) {
      throw new Error('KERNAL tape LOAD returned without consuming physical READ pulses.');
    }
    console.log(
      `PASS Commodore 1530 KERNAL LOAD: BASIC READY in ${bootFrames} PAL frames; ` +
        `${TAPE_FILE.payload.length} exact bytes loaded at $${hex(TAPE_FILE.loadAddress, 4)} ` +
        `in ${loadFrames} frames through ${readPulseCount.toLocaleString('en-US')} READ pulses; ` +
        `TAP SHA-256 ${tapHash}.`,
    );
  } finally {
    stopObservingPulses();
    memory.datasette.disconnect();
  }

  verifyViceWriteWaveform(firmware, viceTapeWriteProgram);
  verifyKernalSaveRoundTrip(firmware);
}

await main();
