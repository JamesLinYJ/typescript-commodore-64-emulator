// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 磁盘端到端外部参考验证器
//
//   文件:       verifyDrive1541Reference.ts
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
import { Commodore1541Drive } from '../src/peripherals/drive1541/Commodore1541Drive';
import { IecBus } from '../src/peripherals/iec/IecBus';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

interface ReferenceAsset {
  readonly cachePath: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly url: string;
}

interface BasicCommandResult {
  readonly frames: number;
}

interface DriveFormatReferenceResult {
  readonly bootFrames: number;
  readonly committedTrackCount: number;
  readonly loadFrames: number;
  readonly programByteLength: number;
  readonly runFrames: number;
}

interface DriveWriteProtectReferenceResult {
  readonly bootFrames: number;
  readonly loadFrames: number;
  readonly programByteLength: number;
  readonly runFrames: number;
  readonly writeByteReadyEdges: number;
}

interface DriveDiskChangeReferenceResult {
  readonly bootFrames: number;
  readonly loadFrames: number;
  readonly runFrames: number;
  readonly sensorStates: readonly number[];
}

interface DriveHlsReferenceResult {
  readonly bootFrames: number;
  readonly resultFrames: number;
  readonly selectedTrack: 17 | 18;
}

const DRIVE_ROM_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/1541-II.251968-03.bin'),
  fileName: '1541-II.251968-03.bin',
  sha256: '326c289c38753323d7e8167897447cf61ef35189d82eb8d75210ece949adda7c',
  url: 'https://www.zimmers.net/anonftp/pub/cbm/firmware/drives/new/1541/1541-II.251968-03.bin',
};

const VICE_TEST_REVISION = 46_176;
const DRIVE_TEST_DISK_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-1541-framework.d64'),
  fileName: 'framework.d64',
  sha256: 'b094002c8b7d868a31fe4d93ab8ea027b2d7feaf6bce083b883c05d22affc128',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/1541-testsuite/disks/framework.d64?format=raw',
};
const VICE_FORMAT_DISK_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-format.d64'),
  fileName: 'format.d64',
  sha256: '7648898420e108b01167d8a04c605fec243e8114e85ad87cd9e537799e6cb54b',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/format/format.d64?format=raw',
};
const VICE_WRITE_PROTECT_DISK_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-writeprotect.d64'),
  fileName: 'writer.d64',
  sha256: 'd822661de5e9f2dd3df9e2ecfecfd63ea4df7171418a008be16fcbf32640a393',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/writeprotect/writer.d64?format=raw',
};
const VICE_WRITE_PROTECT_PROGRAM_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-writeprotect.prg'),
  fileName: 'writer.prg',
  sha256: 'e6a67c943402941c9efa59a1175383019b7ed86aeeac206392a825e80591aa80',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/writeprotect/writer.prg?format=raw',
};
const VICE_DISK_CHANGE_DISK_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-diskchange.d64'),
  fileName: 'disk1.d64',
  sha256: 'fa7ebccdd3aff3d324aa8d21be68275dd60e39ec1962ba61a2e3b83fb878c09a',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/diskchange/disk1.d64?format=raw',
};
const VICE_DISK_CHANGE_PROGRAM_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-diskchange.prg'),
  fileName: 'pollwp.prg',
  sha256: '935394f97c5a29766f99cd7b6a3f35aa0ed271ea1ac14ec90a2535861d05a147',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/diskchange/pollwp.prg?format=raw',
};
const VICE_HLS_DISK_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-hlstest.g64'),
  fileName: 'hlstest.g64',
  sha256: 'a13130665387c4a5623cdeb8dc906a05b6525144c6ab32aa852b8be474c5e726',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/hls-protection/hlstest.g64?format=raw',
};
const VICE_HLS_PROGRAM_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-hlstest.prg'),
  fileName: 'hlstest.prg',
  sha256: '7343367348e00602f8c999e9036c3cc82303016d4c71003093f96578b2131132',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/hls-protection/hlstest.prg?format=raw',
};
const VICE_HLS_LOW_TRACK_EXPECTED_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-hls-expected-t1-17.bin'),
  fileName: 'expected_t1-17.bin',
  sha256: '8e793d318e0f69a2b8c508a802472c22ce6af6df600111841a0bed4128e440e4',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/hls-protection/expected_t1-17.bin?format=raw',
};
const VICE_HLS_HIGH_TRACK_EXPECTED_ASSET: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-drive-hls-expected-t18-35.bin'),
  fileName: 'expected_t18-35.bin',
  sha256: '459e0fdddfc00dfc1011a90002d9af5b2db5448f92804d17d5ebffdcf6bbc8a5',
  url:
    `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
    'testprogs/drive/hls-protection/expected_t18-35.bin?format=raw',
};

const BASIC_BOOT_FRAME_LIMIT = 300;
const DRIVE_COMMAND_FRAME_LIMIT = 600;
const DRIVE_FORMAT_FRAME_LIMIT = 6_000;
const DRIVE_WRITE_PROTECT_FRAME_LIMIT = 1_200;
const DRIVE_DISK_CHANGE_FRAME_LIMIT = 1_200;
const DRIVE_HLS_FRAME_LIMIT = 1_200;
const WRITE_PROTECT_ONLY_ARGUMENT = '--write-protect-only';
const DISK_CHANGE_ONLY_ARGUMENT = '--disk-change-only';
const HLS_ONLY_ARGUMENT = '--hls-only';
const VICE_TEST_RESULT_ADDRESS = 0xd7ff;
const VICE_TEST_SUCCESS_VALUE = 0x00;
const C64_SCREEN_MEMORY = {
  endExclusive: 0x07e8,
  spaceCharacter: 0x20,
  start: 0x0400,
} as const;
const C64_KEYBOARD_BUFFER = {
  capacityAddress: 0x0289,
  countAddress: 0x00c6,
  start: 0x0277,
} as const;
const BASIC_TEXT_END_POINTER = 0x002d;
const KERNAL_LOAD_END_POINTER = 0x00ae;
const BASIC_PROGRAM_START_ADDRESS = 0x0801;

const LOAD_DIRECTORY_COMMAND = petsciiCommand('LOAD"$",8');
const LOAD_FIRST_FILE_COMMAND = petsciiCommand('LOAD"*",8,1');
const NEW_COMMAND = petsciiCommand('NEW');
const ENTER_SAVE_PROGRAM_COMMAND = petsciiCommand('10 PRINT"CODEX"');
const SAVE_TEST_FILE_COMMAND = petsciiCommand('SAVE"CODEX",8');
const LOAD_SAVED_FILE_COMMAND = petsciiCommand('LOAD"CODEX",8');
const LOAD_FORMAT_TEST_COMMAND = petsciiCommand('LOAD"FORMAT",8');
const LOAD_WRITE_PROTECT_TEST_COMMAND = petsciiCommand('LOAD"WRITER",8');
const LOAD_DISK_CHANGE_TEST_COMMAND = petsciiCommand('LOAD"POLLWP",8');
const RUN_COMMAND = petsciiCommand('RUN');
const EXPECTED_DIRECTORY_TITLE = asciiBytes('1541-TESTSUITE');
const EXPECTED_DIRECTORY_ENTRY = asciiBytes('&00>DUMMY-TRUE0');
const SAVED_TEST_FILE_NAME = asciiBytes('CODEX');
const FORMAT_TEST_FILE_NAME = asciiBytes('FORMAT');
const WRITE_PROTECT_TEST_FILE_NAME = asciiBytes('WRITER');
const DISK_CHANGE_TEST_FILE_NAME = asciiBytes('POLLWP');
const DRIVE_WRITE_PROTECT_TEST = {
  driveCodeEndExclusive: 0x0800,
  driveCodeStart: 0x0300,
  driveRomExitAddress: 0xc194,
  machineCodeStart: 0x0810,
  minimumWriteByteReadyEdges: 0x3000 + 0x0200 * 2 + 0x0d + 1,
  programLoadAddress: 0x0801,
} as const;
const DRIVE_DISK_CHANGE_TEST = {
  driveCodeEndExclusive: 0x0800,
  driveCodeStart: 0x0300,
  expectedSensorStates: [0, 1, 0, 1, 0, 1, 0, 1, 0] as const,
  sensorOffInstruction: Uint8Array.of(0xa9, 0x00, 0x8d, 0x20, 0xd0),
  sensorOnInstruction: Uint8Array.of(0xa9, 0x01, 0x8d, 0x20, 0xd0),
} as const;
const DRIVE_HLS_TEST = {
  driveResultStart: 0x04c0,
  embeddedTableLength: 0x40,
  originalSelectedTrack: 17,
  resultSentinel: 0x7f,
  selectedTracks: [17, 18] as const,
} as const;

// BASIC V2 对 `10 PRINT"CODEX"` 的固定 token 化结果。这里把完整 PRG 作为外部可观察
// 预言机，避免用待测 C64 RAM 反过来定义 SAVE 成功与否。
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

const D64_LAYOUT = {
  directory: {
    entryCountPerSector: 8,
    entrySize: 0x20,
    fileNameLength: 16,
    fileNameOffset: 5,
    fileTypeOffset: 2,
    firstSector: 1,
    firstSectorOffset: 4,
    firstTrack: 18,
    firstTrackOffset: 3,
    unusedFileType: 0,
    fileNamePadding: 0xa0,
  },
  sectorSize: 0x0100,
  sectorsPerTrack: [
    { firstTrack: 1, lastTrack: 17, sectors: 21 },
    { firstTrack: 18, lastTrack: 24, sectors: 19 },
    { firstTrack: 25, lastTrack: 30, sectors: 18 },
    { firstTrack: 31, lastTrack: 35, sectors: 17 },
  ],
} as const;
const EXPECTED_FIRST_FILE = {
  loadAddress: 0x0801,
  sha256: '3d992332728ed415b0958b719f3cd1be4410e28da5719c70ce5e51a8e4926063',
  startSector: 0,
  startTrack: 17,
} as const;

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

    const remaining = this.command.length - this.offset;
    const writeCount = Math.min(capacity - used, remaining);
    if (writeCount === 0) return;
    const chunk = this.command.subarray(this.offset, this.offset + writeCount);
    memory.injectRamImage(C64_KEYBOARD_BUFFER.start + used, chunk);
    memory.ram[C64_KEYBOARD_BUFFER.countAddress] = used + writeCount;
    this.offset += writeCount;
  }
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
  c64Cpu: Cpu6502,
  drive: Commodore1541Drive,
  command: Uint8Array,
  label: string,
  frameLimit = DRIVE_COMMAND_FRAME_LIMIT,
): BasicCommandResult {
  memory.ram.fill(
    C64_SCREEN_MEMORY.spaceCharacter,
    C64_SCREEN_MEMORY.start,
    C64_SCREEN_MEMORY.endExclusive,
  );
  const feeder = new BasicKeyboardCommandFeeder(command);

  for (let frame = 1; frame <= frameLimit; frame += 1) {
    feeder.refill(memory);
    scheduler.runFrame();

    if (c64Cpu.isJammed) throw new Error(`${label} entered the C64 6510 JAM state.`);
    if (drive.cpu.isJammed) throw new Error(`${label} entered the 1541 6502 JAM state.`);
    const keyboardEmpty = (memory.ram[C64_KEYBOARD_BUFFER.countAddress] ?? 0) === 0;
    if (feeder.finished && keyboardEmpty && hasBasicReadyPrompt(memory)) return { frames: frame };
  }

  const bus = drive.iecVia.iecBus.state;
  const c64Registers = c64Cpu.getRegisters();
  const driveRegisters = drive.cpu.getRegisters();
  throw new Error(
    `${label} did not return to BASIC READY within ${frameLimit} PAL frames; ` +
      `C64 PC=$${hex(c64Registers.programCounter, 4)}, P=$${hex(c64Registers.status, 2)}, ` +
      `KERNAL status=$${hex(memory.ram[0x0090] ?? 0, 2)}, ` +
      `CIA2 PRA=$${hex(memory.cia2.portAOutputLatch, 2)}, ` +
      `DDRA=$${hex(memory.cia2.portADataDirection, 2)}, ` +
      `drive PC=$${hex(driveRegisters.programCounter, 4)}, P=$${hex(driveRegisters.status, 2)}, ` +
      `VIA1 ORB=$${hex(drive.iecVia.portBOutputLatch, 2)}, ` +
      `DDRB=$${hex(drive.iecVia.portBDataDirection, 2)}, ` +
      `IRQ=${String(drive.iecVia.interruptPending)}, ` +
      `IEC=${Number(bus.attentionHigh)}${Number(bus.clockHigh)}${Number(bus.dataHigh)}` +
      `${Number(bus.resetHigh)}, head=${drive.mechanism.currentTrack}, ` +
      `motor=${String(drive.mechanism.motorOn)}.`,
  );
}

function enterBasicProgramLine(
  scheduler: PalFrameScheduler,
  memory: C64Memory,
  c64Cpu: Cpu6502,
  drive: Commodore1541Drive,
  command: Uint8Array,
  expectedFile: Uint8Array,
): BasicCommandResult {
  const feeder = new BasicKeyboardCommandFeeder(command);
  for (let frame = 1; frame <= DRIVE_COMMAND_FRAME_LIMIT; frame += 1) {
    feeder.refill(memory);
    scheduler.runFrame();
    if (c64Cpu.isJammed) throw new Error('BASIC line entry entered the C64 6510 JAM state.');
    if (drive.cpu.isJammed) throw new Error('BASIC line entry entered the 1541 6502 JAM state.');
    const keyboardEmpty = (memory.ram[C64_KEYBOARD_BUFFER.countAddress] ?? 0) === 0;
    if (feeder.finished && keyboardEmpty && basicProgramMatchesMemory(memory, expectedFile)) {
      return { frames: frame };
    }
  }
  throw new Error(
    `BASIC line entry did not produce the fixed tokenized program within ` +
      `${DRIVE_COMMAND_FRAME_LIMIT} PAL frames.`,
  );
}

function readRamWord(memory: C64Memory, address: number): number {
  return (memory.ram[address] ?? 0) | ((memory.ram[address + 1] ?? 0) << 8);
}

function assertMemoryContains(memory: C64Memory, expected: Uint8Array, label: string): void {
  const address = findSequence(memory.ram, expected, 0x0801, 0x4000);
  if (address === undefined) {
    throw new Error(`${label} is missing from the directory program loaded into C64 RAM.`);
  }
}

function assertLoadedFile(memory: C64Memory, file: Uint8Array): void {
  if (sha256(file) !== EXPECTED_FIRST_FILE.sha256) {
    throw new Error(`Extracted first disk file SHA-256 does not match its fixed reference.`);
  }
  const loadAddress = (file[0] ?? 0) | ((file[1] ?? 0) << 8);
  if (loadAddress !== EXPECTED_FIRST_FILE.loadAddress) {
    throw new Error(
      `First disk file load address is $${hex(loadAddress, 4)}; ` +
        `expected $${hex(EXPECTED_FIRST_FILE.loadAddress, 4)}.`,
    );
  }

  const payload = file.subarray(2);
  for (let offset = 0; offset < payload.length; offset += 1) {
    const actual = memory.ram[loadAddress + offset];
    const expected = payload[offset];
    if (actual !== expected) {
      throw new Error(
        `1541 LOAD mismatch at $${hex(loadAddress + offset, 4)}: ` +
          `received $${hex(actual ?? 0, 2)}, expected $${hex(expected ?? 0, 2)}.`,
      );
    }
  }

  const expectedEndAddress = loadAddress + payload.length;
  const actualEndAddress = readRamWord(memory, KERNAL_LOAD_END_POINTER);
  if (actualEndAddress !== expectedEndAddress) {
    throw new Error(
      `KERNAL LOAD end pointer is $${hex(actualEndAddress, 4)}; ` +
        `expected $${hex(expectedEndAddress, 4)}.`,
    );
  }
}

function assertBasicProgramInMemory(memory: C64Memory, expectedFile: Uint8Array): void {
  const loadAddress = (expectedFile[0] ?? 0) | ((expectedFile[1] ?? 0) << 8);
  if (loadAddress !== BASIC_PROGRAM_START_ADDRESS) {
    throw new Error(`SAVE oracle has unexpected load address $${hex(loadAddress, 4)}.`);
  }
  const payload = expectedFile.subarray(2);
  assertBytesEqual(
    memory.ram.subarray(loadAddress, loadAddress + payload.length),
    payload,
    'Tokenized BASIC program in C64 RAM',
  );
  const actualEndAddress = readRamWord(memory, BASIC_TEXT_END_POINTER);
  const expectedEndAddress = loadAddress + payload.length;
  if (actualEndAddress !== expectedEndAddress) {
    throw new Error(
      `BASIC text end pointer is $${hex(actualEndAddress, 4)}; ` +
        `expected $${hex(expectedEndAddress, 4)}.`,
    );
  }
}

function basicProgramMatchesMemory(memory: C64Memory, expectedFile: Uint8Array): boolean {
  const loadAddress = (expectedFile[0] ?? 0) | ((expectedFile[1] ?? 0) << 8);
  const payload = expectedFile.subarray(2);
  if (readRamWord(memory, BASIC_TEXT_END_POINTER) !== loadAddress + payload.length) return false;
  for (let index = 0; index < payload.length; index += 1) {
    if (memory.ram[loadAddress + index] !== payload[index]) return false;
  }
  return true;
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (actual.length !== expected.length) {
    throw new Error(`${label} has ${actual.length} bytes; expected ${expected.length}.`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] === expected[index]) continue;
    throw new Error(
      `${label} mismatch at offset ${index}: received $${hex(actual[index] ?? 0, 2)}, ` +
        `expected $${hex(expected[index] ?? 0, 2)}.`,
    );
  }
}

function extractNamedD64File(disk: Uint8Array, fileName: Uint8Array): Uint8Array {
  const directory = D64_LAYOUT.directory;
  const visited = new Set<string>();
  let track: number = directory.firstTrack;
  let sector: number = directory.firstSector;

  while (track !== 0) {
    const key = `${track}:${sector}`;
    if (visited.has(key)) throw new Error(`D64 directory chain contains a loop at ${key}.`);
    visited.add(key);
    const offset = d64SectorOffset(track, sector);
    if (offset + D64_LAYOUT.sectorSize > disk.length) {
      throw new Error(`D64 directory sector ${key} is outside the disk image.`);
    }

    for (let entryIndex = 0; entryIndex < directory.entryCountPerSector; entryIndex += 1) {
      const entryOffset = offset + entryIndex * directory.entrySize;
      const fileType = disk[entryOffset + directory.fileTypeOffset] ?? directory.unusedFileType;
      if (fileType === directory.unusedFileType) continue;
      if (!directoryNameMatches(disk, entryOffset, fileName)) continue;
      const startTrack = disk[entryOffset + directory.firstTrackOffset] ?? 0;
      const startSector = disk[entryOffset + directory.firstSectorOffset] ?? 0;
      if (startTrack === 0) throw new Error(`D64 file ${asciiLabel(fileName)} has no first track.`);
      return extractD64File(disk, startTrack, startSector);
    }

    track = disk[offset] ?? 0;
    sector = disk[offset + 1] ?? 0;
  }
  throw new Error(`D64 directory does not contain ${asciiLabel(fileName)}.`);
}

function directoryNameMatches(
  disk: Uint8Array,
  entryOffset: number,
  expected: Uint8Array,
): boolean {
  const directory = D64_LAYOUT.directory;
  if (expected.length > directory.fileNameLength) return false;
  for (let index = 0; index < directory.fileNameLength; index += 1) {
    const expectedByte = expected[index] ?? directory.fileNamePadding;
    if (disk[entryOffset + directory.fileNameOffset + index] !== expectedByte) return false;
  }
  return true;
}

function asciiLabel(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function extractD64File(disk: Uint8Array, startTrack: number, startSector: number): Uint8Array {
  const file: number[] = [];
  const visited = new Set<string>();
  let track = startTrack;
  let sector = startSector;

  while (track !== 0) {
    const key = `${track}:${sector}`;
    if (visited.has(key)) throw new Error(`D64 file chain contains a loop at ${key}.`);
    visited.add(key);

    const offset = d64SectorOffset(track, sector);
    if (offset + D64_LAYOUT.sectorSize > disk.length) {
      throw new Error(`D64 file sector ${key} is outside the fixed disk image.`);
    }
    const nextTrack = disk[offset] ?? 0;
    const nextSector = disk[offset + 1] ?? 0;
    const dataLength = nextTrack === 0 ? nextSector - 1 : D64_LAYOUT.sectorSize - 2;
    if (dataLength < 0 || dataLength > D64_LAYOUT.sectorSize - 2) {
      throw new Error(`D64 terminal sector ${key} declares invalid length ${dataLength}.`);
    }
    for (let index = 0; index < dataLength; index += 1) {
      const value = disk[offset + 2 + index];
      if (value === undefined) throw new Error(`D64 file sector ${key} ended unexpectedly.`);
      file.push(value);
    }
    track = nextTrack;
    sector = nextSector;
  }

  return Uint8Array.from(file);
}

function d64SectorOffset(track: number, sector: number): number {
  const sectorsOnTrack = d64SectorsOnTrack(track);
  if (!Number.isInteger(sector) || sector < 0 || sector >= sectorsOnTrack) {
    throw new RangeError(`D64 track ${track} does not contain sector ${sector}.`);
  }
  let precedingSectors = 0;
  for (let precedingTrack = 1; precedingTrack < track; precedingTrack += 1) {
    precedingSectors += d64SectorsOnTrack(precedingTrack);
  }
  return (precedingSectors + sector) * D64_LAYOUT.sectorSize;
}

function d64SectorsOnTrack(track: number): number {
  const zone = D64_LAYOUT.sectorsPerTrack.find(
    ({ firstTrack, lastTrack }) => track >= firstTrack && track <= lastTrack,
  );
  if (!zone) throw new RangeError(`Fixed D64 reference has no track ${track}.`);
  return zone.sectors;
}

function findSequence(
  bytes: Uint8Array,
  sequence: Uint8Array,
  start: number,
  endExclusive: number,
): number | undefined {
  const finalStart = Math.min(bytes.length, endExclusive) - sequence.length;
  for (let offset = start; offset <= finalStart; offset += 1) {
    let matches = true;
    for (let index = 0; index < sequence.length; index += 1) {
      if (bytes[offset + index] !== sequence[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return offset;
  }
  return undefined;
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function petsciiCommand(value: string): Uint8Array {
  const command = new Uint8Array(value.length + 1);
  command.set(asciiBytes(value));
  command[value.length] = 0x0d;
  return command;
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, '0');
}

function writeProtectPassMessage(reference: DriveWriteProtectReferenceResult): string {
  return (
    `PASS VICE drive/writeprotect/writer.prg revision ${VICE_TEST_REVISION}: BASIC READY in ` +
    `${reference.bootFrames} PAL frames; loaded in ${reference.loadFrames}; raw VIA2 writer ` +
    `completed in ${reference.runFrames}; observed ` +
    `${reference.writeByteReadyEdges.toLocaleString('en-US')} write-byte edges and preserved ` +
    `the exact ${reference.programByteLength}-byte program, raw track 18 and D64 image.`
  );
}

function diskChangePassMessage(reference: DriveDiskChangeReferenceResult): string {
  return (
    `PASS VICE drive/diskchange/pollwp.prg revision ${VICE_TEST_REVISION}: BASIC READY in ` +
    `${reference.bootFrames} PAL frames; loaded in ${reference.loadFrames}; automated eject, ` +
    `insert and immediate replacement completed in ${reference.runFrames}; observed PB4 states ` +
    `${reference.sensorStates.join('→')}.`
  );
}

function uniqueProgramSequenceAddress(
  program: Uint8Array,
  sequence: Uint8Array,
  label: string,
): number {
  const loadAddress = (program[0] ?? 0) | ((program[1] ?? 0) << 8);
  const firstOffset = findSequence(program, sequence, 2, program.length);
  if (firstOffset === undefined) throw new Error(`${label} instruction is missing from its PRG.`);
  const duplicate = findSequence(program, sequence, firstOffset + 1, program.length);
  if (duplicate !== undefined) {
    throw new Error(`${label} instruction occurs more than once in its fixed PRG.`);
  }
  return loadAddress + firstOffset - 2;
}

function runViceFormatReference(
  firmware: C64Firmware,
  driveRom: Uint8Array,
  formatDiskBytes: Uint8Array,
): DriveFormatReferenceResult {
  // 使用全新整机而不是在前一个用例后热换盘。这样测试只衡量 VICE format.prg 所要求的
  // 复位起始状态，不把尚未单独建模的开门换盘瞬态混进格式化结果。
  const iecBus = new IecBus();
  const memory = new C64Memory(firmware, { iecBus });
  const c64Cpu = new Cpu6502(memory);
  const drive = new Commodore1541Drive({ deviceNumber: 8, iecBus, rom: driveRom });
  const formatDisk = drive.mountD64(formatDiskBytes, { writeProtected: false });
  const scheduler = new PalFrameScheduler(c64Cpu, memory, [drive.clock]);
  const expectedFormatProgram = extractNamedD64File(formatDiskBytes, FORMAT_TEST_FILE_NAME);

  try {
    const bootFrames = bootToBasicReady(scheduler, memory);
    const formatProgramLoad = runBasicCommand(
      scheduler,
      memory,
      c64Cpu,
      drive,
      LOAD_FORMAT_TEST_COMMAND,
      'LOAD"FORMAT",8',
    );
    let formatResult: number | undefined;
    const stopObservingFormatResult = memory.observeWrites(({ address, value }) => {
      if (address === VICE_TEST_RESULT_ADDRESS) formatResult = value;
    });
    let formatRun: BasicCommandResult;
    try {
      formatRun = runBasicCommand(
        scheduler,
        memory,
        c64Cpu,
        drive,
        RUN_COMMAND,
        'VICE drive/format/format.prg',
        DRIVE_FORMAT_FRAME_LIMIT,
      );
    } finally {
      stopObservingFormatResult();
    }
    if (formatResult === undefined) {
      throw new Error('VICE drive format test returned to BASIC without reporting at $D7FF.');
    }
    if (formatResult !== VICE_TEST_SUCCESS_VALUE) {
      throw new Error(`VICE drive format test failed with result $${hex(formatResult, 2)}.`);
    }
    const formatCommit = drive.mechanism.commitRawTrackWritesToD64Sectors();
    if (formatCommit.failures.length !== 0 || formatCommit.remainingDirtyHalfTracks.length !== 0) {
      throw new Error(
        `VICE drive format test produced D64-incompatible tracks: ${JSON.stringify(formatCommit)}.`,
      );
    }
    const reformattedProgram = extractNamedD64File(
      formatDisk.toBytes(false),
      FORMAT_TEST_FILE_NAME,
    );
    assertBytesEqual(reformattedProgram, expectedFormatProgram, 'Reformatted FORMAT PRG');
    return {
      bootFrames,
      committedTrackCount: formatCommit.committedHalfTracks.length,
      loadFrames: formatProgramLoad.frames,
      programByteLength: reformattedProgram.length,
      runFrames: formatRun.frames,
    };
  } finally {
    drive.dispose();
  }
}

function runViceWriteProtectReference(
  firmware: C64Firmware,
  driveRom: Uint8Array,
  writerDiskBytes: Uint8Array,
  writerProgramBytes: Uint8Array,
): DriveWriteProtectReferenceResult {
  const iecBus = new IecBus();
  const memory = new C64Memory(firmware, { iecBus });
  const c64Cpu = new Cpu6502(memory);
  const drive = new Commodore1541Drive({ deviceNumber: 8, iecBus, rom: driveRom });
  const disk = drive.mountD64(writerDiskBytes, { writeProtected: true });
  const scheduler = new PalFrameScheduler(c64Cpu, memory, [drive.clock]);
  const diskProgram = extractNamedD64File(writerDiskBytes, WRITE_PROTECT_TEST_FILE_NAME);
  assertBytesEqual(diskProgram, writerProgramBytes, 'VICE WRITER program in fixed D64');

  let stopObservingByteReady: (() => void) | undefined;
  let previousDriveInstructionObserver: ReturnType<typeof drive.cpu.setInstructionObserver> =
    undefined;
  try {
    const bootFrames = bootToBasicReady(scheduler, memory);
    const load = runBasicCommand(
      scheduler,
      memory,
      c64Cpu,
      drive,
      LOAD_WRITE_PROTECT_TEST_COMMAND,
      'LOAD"WRITER",8',
    );
    const loadAddress = (writerProgramBytes[0] ?? 0) | ((writerProgramBytes[1] ?? 0) << 8);
    if (loadAddress !== DRIVE_WRITE_PROTECT_TEST.programLoadAddress) {
      throw new Error(
        `VICE WRITER load address is $${hex(loadAddress, 4)}; expected ` +
          `$${hex(DRIVE_WRITE_PROTECT_TEST.programLoadAddress, 4)}.`,
      );
    }
    const machineCodeOffset =
      DRIVE_WRITE_PROTECT_TEST.machineCodeStart - DRIVE_WRITE_PROTECT_TEST.programLoadAddress;
    assertBytesEqual(
      memory.ram.subarray(
        DRIVE_WRITE_PROTECT_TEST.machineCodeStart,
        loadAddress + writerProgramBytes.length - 2,
      ),
      writerProgramBytes.subarray(2 + machineCodeOffset),
      'Loaded VICE WRITER machine code',
    );

    const rawTrackBefore = drive.mechanism.readRawHalfTrack(36);
    const diskBefore = disk.toBytes(false);
    let customDriveCodeEntered = false;
    let customDriveCodeExited = false;
    let writeModeObserved = false;
    let writeByteReadyEdges = 0;

    previousDriveInstructionObserver = drive.cpu.setInstructionObserver((address) => {
      if (
        address >= DRIVE_WRITE_PROTECT_TEST.driveCodeStart &&
        address < DRIVE_WRITE_PROTECT_TEST.driveCodeEndExclusive
      ) {
        customDriveCodeEntered = true;
      }
      if (customDriveCodeEntered && address === DRIVE_WRITE_PROTECT_TEST.driveRomExitAddress) {
        customDriveCodeExited = true;
      }
    });
    stopObservingByteReady = drive.mechanism.observeByteReadyEdge(() => {
      if (!customDriveCodeEntered || drive.mechanism.reading) return;
      writeModeObserved = true;
      writeByteReadyEdges += 1;
    });

    const feeder = new BasicKeyboardCommandFeeder(RUN_COMMAND);
    let runFrames = 0;
    for (let frame = 1; frame <= DRIVE_WRITE_PROTECT_FRAME_LIMIT; frame += 1) {
      feeder.refill(memory);
      scheduler.runFrame();
      if (c64Cpu.isJammed) throw new Error('VICE WRITER entered the C64 6510 JAM state.');
      if (drive.cpu.isJammed) throw new Error('VICE WRITER entered the 1541 6502 JAM state.');
      if (!customDriveCodeExited) continue;
      runFrames = frame;
      break;
    }

    if (!customDriveCodeEntered || !customDriveCodeExited || runFrames === 0) {
      throw new Error(
        `VICE WRITER did not execute $${hex(DRIVE_WRITE_PROTECT_TEST.driveCodeStart, 4)} ` +
          `and return through $${hex(DRIVE_WRITE_PROTECT_TEST.driveRomExitAddress, 4)} within ` +
          `${DRIVE_WRITE_PROTECT_FRAME_LIMIT} PAL frames.`,
      );
    }
    if (!writeModeObserved) {
      throw new Error(
        'VICE WRITER returned without switching the 1541 read/write head to write mode.',
      );
    }
    if (writeByteReadyEdges < DRIVE_WRITE_PROTECT_TEST.minimumWriteByteReadyEdges) {
      throw new Error(
        `VICE WRITER observed ${writeByteReadyEdges} write BYTE READY edges; expected at least ` +
          `${DRIVE_WRITE_PROTECT_TEST.minimumWriteByteReadyEdges}.`,
      );
    }
    if (drive.mechanism.dirtyHalfTracks.length !== 0) {
      throw new Error(
        `Write-protected VICE WRITER media marked dirty half-tracks ` +
          `${drive.mechanism.dirtyHalfTracks.join(', ')}.`,
      );
    }
    assertBytesEqual(
      drive.mechanism.readRawHalfTrack(36),
      rawTrackBefore,
      'Write-protected raw track 18',
    );
    assertBytesEqual(disk.toBytes(false), diskBefore, 'Write-protected VICE WRITER D64');
    return {
      bootFrames,
      loadFrames: load.frames,
      programByteLength: writerProgramBytes.length,
      runFrames,
      writeByteReadyEdges,
    };
  } finally {
    stopObservingByteReady?.();
    if (previousDriveInstructionObserver !== undefined) {
      drive.cpu.setInstructionObserver(previousDriveInstructionObserver);
    }
    drive.dispose();
  }
}

function runViceDiskChangeReference(
  firmware: C64Firmware,
  driveRom: Uint8Array,
  diskBytes: Uint8Array,
  programBytes: Uint8Array,
): DriveDiskChangeReferenceResult {
  const iecBus = new IecBus();
  const memory = new C64Memory(firmware, { iecBus });
  const c64Cpu = new Cpu6502(memory);
  const drive = new Commodore1541Drive({ deviceNumber: 8, iecBus, rom: driveRom });
  drive.mountD64(diskBytes, { writeProtected: false });
  const scheduler = new PalFrameScheduler(c64Cpu, memory, [drive.clock]);
  const diskProgram = extractNamedD64File(diskBytes, DISK_CHANGE_TEST_FILE_NAME);
  assertBytesEqual(diskProgram, programBytes, 'VICE POLLWP program in fixed D64');
  const sensorOffAddress = uniqueProgramSequenceAddress(
    programBytes,
    DRIVE_DISK_CHANGE_TEST.sensorOffInstruction,
    'POLLWP sensor-off',
  );
  const sensorOnAddress = uniqueProgramSequenceAddress(
    programBytes,
    DRIVE_DISK_CHANGE_TEST.sensorOnInstruction,
    'POLLWP sensor-on',
  );

  let previousC64InstructionObserver: ReturnType<typeof c64Cpu.setInstructionObserver> = undefined;
  let previousDriveInstructionObserver: ReturnType<typeof drive.cpu.setInstructionObserver> =
    undefined;
  try {
    const bootFrames = bootToBasicReady(scheduler, memory);
    const load = runBasicCommand(
      scheduler,
      memory,
      c64Cpu,
      drive,
      LOAD_DISK_CHANGE_TEST_COMMAND,
      'LOAD"POLLWP",8',
    );
    const sensorStates: number[] = [];
    let customDriveCodeEntered = false;
    let mediaAction = 0;

    previousC64InstructionObserver = c64Cpu.setInstructionObserver((address) => {
      const state = address === sensorOffAddress ? 0 : address === sensorOnAddress ? 1 : undefined;
      if (state === undefined || sensorStates.at(-1) === state) return;
      sensorStates.push(state);
    });
    previousDriveInstructionObserver = drive.cpu.setInstructionObserver((address) => {
      if (
        address >= DRIVE_DISK_CHANGE_TEST.driveCodeStart &&
        address < DRIVE_DISK_CHANGE_TEST.driveCodeEndExclusive
      ) {
        customDriveCodeEntered = true;
      }
    });

    const feeder = new BasicKeyboardCommandFeeder(RUN_COMMAND);
    let runFrames = 0;
    for (let frame = 1; frame <= DRIVE_DISK_CHANGE_FRAME_LIMIT; frame += 1) {
      feeder.refill(memory);
      scheduler.runFrame();
      if (c64Cpu.isJammed) throw new Error('VICE POLLWP entered the C64 6510 JAM state.');
      if (drive.cpu.isJammed) throw new Error('VICE POLLWP entered the 1541 6502 JAM state.');

      if (mediaAction === 0 && sensorStates.length >= 1) {
        drive.ejectD64();
        mediaAction = 1;
      } else if (mediaAction === 1 && sensorStates.length >= 3) {
        drive.mountD64(diskBytes, { writeProtected: false });
        mediaAction = 2;
      } else if (mediaAction === 2 && sensorStates.length >= 5) {
        drive.ejectD64();
        drive.mountD64(diskBytes, { writeProtected: false });
        mediaAction = 3;
      }

      if (
        mediaAction !== 3 ||
        sensorStates.length < DRIVE_DISK_CHANGE_TEST.expectedSensorStates.length
      ) {
        continue;
      }
      runFrames = frame;
      break;
    }

    if (!customDriveCodeEntered) {
      throw new Error(
        `VICE POLLWP did not execute drive code at ` +
          `$${hex(DRIVE_DISK_CHANGE_TEST.driveCodeStart, 4)}.`,
      );
    }
    if (runFrames === 0) {
      throw new Error(
        `VICE POLLWP did not observe the complete media-change sequence within ` +
          `${DRIVE_DISK_CHANGE_FRAME_LIMIT} PAL frames; received ${sensorStates.join('→')}.`,
      );
    }
    const expectedStates = DRIVE_DISK_CHANGE_TEST.expectedSensorStates;
    if (
      sensorStates.length !== expectedStates.length ||
      sensorStates.some((state, index) => state !== expectedStates[index])
    ) {
      throw new Error(
        `VICE POLLWP observed PB4 states ${sensorStates.join('→')}; expected ` +
          `${expectedStates.join('→')}.`,
      );
    }
    if (drive.mechanism.writeProtectSensorActive) {
      throw new Error('VICE POLLWP ended before the writable replacement disk sensor settled off.');
    }
    return {
      bootFrames,
      loadFrames: load.frames,
      runFrames,
      sensorStates,
    };
  } finally {
    c64Cpu.setInstructionObserver(previousC64InstructionObserver);
    drive.cpu.setInstructionObserver(previousDriveInstructionObserver);
    drive.dispose();
  }
}

function prepareHlsProgram(
  programBytes: Uint8Array,
  selectedTrack: 17 | 18,
  lowTrackExpected: Uint8Array,
  highTrackExpected: Uint8Array,
): Uint8Array {
  if (
    lowTrackExpected.length !== DRIVE_HLS_TEST.embeddedTableLength ||
    highTrackExpected.length !== DRIVE_HLS_TEST.embeddedTableLength
  ) {
    throw new Error('VICE HLS expected tables must each contain exactly 64 bytes.');
  }
  for (const [label, table] of [
    ['low-track', lowTrackExpected],
    ['high-track', highTrackExpected],
  ] as const) {
    const offset = findSequence(programBytes, table, 2, programBytes.length);
    if (offset === undefined) throw new Error(`VICE HLS PRG does not embed its ${label} table.`);
    if (findSequence(programBytes, table, offset + 1, programBytes.length) !== undefined) {
      throw new Error(`VICE HLS PRG embeds its ${label} table more than once.`);
    }
  }

  const executeCommand = asciiBytes('E-M');
  const markerOffset = findSequence(programBytes, executeCommand, 2, programBytes.length);
  if (markerOffset === undefined || markerOffset < 3) {
    throw new Error('VICE HLS PRG does not contain its M-E command parameter.');
  }
  if (
    findSequence(programBytes, executeCommand, markerOffset + 1, programBytes.length) !== undefined
  ) {
    throw new Error('VICE HLS PRG contains more than one M-E command marker.');
  }
  const selectedTrackOffset = markerOffset - 3;
  if (programBytes[selectedTrackOffset] !== DRIVE_HLS_TEST.originalSelectedTrack) {
    throw new Error(
      `VICE HLS default track is ${String(programBytes[selectedTrackOffset])}; expected ` +
        `${DRIVE_HLS_TEST.originalSelectedTrack}.`,
    );
  }

  const selectedProgram = programBytes.slice();
  selectedProgram[selectedTrackOffset] = selectedTrack;
  return selectedProgram;
}

function runViceHlsReference(
  firmware: C64Firmware,
  driveRom: Uint8Array,
  diskBytes: Uint8Array,
  programBytes: Uint8Array,
  lowTrackExpected: Uint8Array,
  highTrackExpected: Uint8Array,
  selectedTrack: 17 | 18,
): DriveHlsReferenceResult {
  const selectedProgram = prepareHlsProgram(
    programBytes,
    selectedTrack,
    lowTrackExpected,
    highTrackExpected,
  );
  const expected = selectedTrack < 18 ? lowTrackExpected : highTrackExpected;
  const iecBus = new IecBus();
  const memory = new C64Memory(firmware, { iecBus });
  const c64Cpu = new Cpu6502(memory);
  const drive = new Commodore1541Drive({ deviceNumber: 8, iecBus, rom: driveRom });
  drive.mountG64(diskBytes, { writeProtected: true });
  const scheduler = new PalFrameScheduler(c64Cpu, memory, [drive.clock]);

  try {
    const bootFrames = bootToBasicReady(scheduler, memory);
    memory.ram[VICE_TEST_RESULT_ADDRESS] = DRIVE_HLS_TEST.resultSentinel;
    let result: number | undefined;
    const stopObservingResult = memory.observeWrites(({ address, value }) => {
      if (address === VICE_TEST_RESULT_ADDRESS) result = value;
    });
    try {
      installPrg(parsePrg(selectedProgram), memory, c64Cpu, {
        startMode: PRG_START_MODE.basicRun,
      });
      for (let frame = 1; frame <= DRIVE_HLS_FRAME_LIMIT; frame += 1) {
        scheduler.runFrame();
        if (c64Cpu.isJammed) throw new Error('VICE HLSTEST entered the C64 6510 JAM state.');
        if (drive.cpu.isJammed) throw new Error('VICE HLSTEST entered the 1541 6502 JAM state.');
        if (result === undefined) continue;
        if (result !== VICE_TEST_SUCCESS_VALUE) {
          throw new Error(
            `VICE HLSTEST track ${selectedTrack} failed with result $${hex(result, 2)}.`,
          );
        }

        const actual = Uint8Array.from(
          { length: DRIVE_HLS_TEST.embeddedTableLength },
          (_unused, index) => drive.memory.read(DRIVE_HLS_TEST.driveResultStart + index),
        );
        assertBytesEqual(actual, expected, `VICE HLSTEST track ${selectedTrack} drive result`);
        return { bootFrames, resultFrames: frame, selectedTrack };
      }
    } finally {
      stopObservingResult();
    }
    throw new Error(
      `VICE HLSTEST track ${selectedTrack} did not report at $D7FF within ` +
        `${DRIVE_HLS_FRAME_LIMIT} PAL frames.`,
    );
  } finally {
    drive.dispose();
  }
}

function hlsPassMessage(references: readonly DriveHlsReferenceResult[]): string {
  return (
    `PASS VICE drive/hls-protection revision ${VICE_TEST_REVISION}: tracks ` +
    `${references.map(({ selectedTrack }) => selectedTrack).join(' and ')} reproduced exact ` +
    `${DRIVE_HLS_TEST.embeddedTableLength}-byte timing tables in ` +
    `${references.map(({ resultFrames }) => resultFrames).join(' and ')} PAL frames after ` +
    `${references[0]?.bootFrames ?? 0}-frame BASIC boots.`
  );
}

async function main(): Promise<void> {
  if (process.argv.includes(WRITE_PROTECT_ONLY_ARGUMENT)) {
    const [firmware, driveRom, diskBytes, programBytes] = await Promise.all([
      loadFirmware(),
      loadReferenceAsset(DRIVE_ROM_ASSET),
      loadReferenceAsset(VICE_WRITE_PROTECT_DISK_ASSET),
      loadReferenceAsset(VICE_WRITE_PROTECT_PROGRAM_ASSET),
    ]);
    const reference = runViceWriteProtectReference(firmware, driveRom, diskBytes, programBytes);
    console.log(writeProtectPassMessage(reference));
    return;
  }
  if (process.argv.includes(DISK_CHANGE_ONLY_ARGUMENT)) {
    const [firmware, driveRom, diskBytes, programBytes] = await Promise.all([
      loadFirmware(),
      loadReferenceAsset(DRIVE_ROM_ASSET),
      loadReferenceAsset(VICE_DISK_CHANGE_DISK_ASSET),
      loadReferenceAsset(VICE_DISK_CHANGE_PROGRAM_ASSET),
    ]);
    const reference = runViceDiskChangeReference(firmware, driveRom, diskBytes, programBytes);
    console.log(diskChangePassMessage(reference));
    return;
  }
  if (process.argv.includes(HLS_ONLY_ARGUMENT)) {
    const [firmware, driveRom, diskBytes, programBytes, lowTrackExpected, highTrackExpected] =
      await Promise.all([
        loadFirmware(),
        loadReferenceAsset(DRIVE_ROM_ASSET),
        loadReferenceAsset(VICE_HLS_DISK_ASSET),
        loadReferenceAsset(VICE_HLS_PROGRAM_ASSET),
        loadReferenceAsset(VICE_HLS_LOW_TRACK_EXPECTED_ASSET),
        loadReferenceAsset(VICE_HLS_HIGH_TRACK_EXPECTED_ASSET),
      ]);
    const references = DRIVE_HLS_TEST.selectedTracks.map((selectedTrack) =>
      runViceHlsReference(
        firmware,
        driveRom,
        diskBytes,
        programBytes,
        lowTrackExpected,
        highTrackExpected,
        selectedTrack,
      ),
    );
    console.log(hlsPassMessage(references));
    return;
  }

  const [
    firmware,
    driveRom,
    diskBytes,
    formatDiskBytes,
    writeProtectDiskBytes,
    writeProtectProgramBytes,
    diskChangeDiskBytes,
    diskChangeProgramBytes,
    hlsDiskBytes,
    hlsProgramBytes,
    hlsLowTrackExpected,
    hlsHighTrackExpected,
  ] = await Promise.all([
    loadFirmware(),
    loadReferenceAsset(DRIVE_ROM_ASSET),
    loadReferenceAsset(DRIVE_TEST_DISK_ASSET),
    loadReferenceAsset(VICE_FORMAT_DISK_ASSET),
    loadReferenceAsset(VICE_WRITE_PROTECT_DISK_ASSET),
    loadReferenceAsset(VICE_WRITE_PROTECT_PROGRAM_ASSET),
    loadReferenceAsset(VICE_DISK_CHANGE_DISK_ASSET),
    loadReferenceAsset(VICE_DISK_CHANGE_PROGRAM_ASSET),
    loadReferenceAsset(VICE_HLS_DISK_ASSET),
    loadReferenceAsset(VICE_HLS_PROGRAM_ASSET),
    loadReferenceAsset(VICE_HLS_LOW_TRACK_EXPECTED_ASSET),
    loadReferenceAsset(VICE_HLS_HIGH_TRACK_EXPECTED_ASSET),
  ]);

  const iecBus = new IecBus();
  const memory = new C64Memory(firmware, { iecBus });
  const c64Cpu = new Cpu6502(memory);
  const drive = new Commodore1541Drive({ deviceNumber: 8, iecBus, rom: driveRom });
  const disk = drive.mountD64(diskBytes, { writeProtected: false });
  const scheduler = new PalFrameScheduler(c64Cpu, memory, [drive.clock]);
  let iecTransitions = 0;
  const stopObservingIec = iecBus.observe(() => {
    iecTransitions += 1;
  });

  try {
    const bootFrames = bootToBasicReady(scheduler, memory);
    const directory = runBasicCommand(
      scheduler,
      memory,
      c64Cpu,
      drive,
      LOAD_DIRECTORY_COMMAND,
      'LOAD"$",8',
    );
    assertMemoryContains(memory, EXPECTED_DIRECTORY_TITLE, 'VICE 1541 test disk title');
    assertMemoryContains(memory, EXPECTED_DIRECTORY_ENTRY, 'VICE 1541 test disk first entry');
    const directoryEndAddress = readRamWord(memory, BASIC_TEXT_END_POINTER);
    if (directoryEndAddress <= EXPECTED_FIRST_FILE.loadAddress) {
      throw new Error(
        `Directory BASIC end pointer $${hex(directoryEndAddress, 4)} did not advance.`,
      );
    }

    const firstFile = extractD64File(
      diskBytes,
      EXPECTED_FIRST_FILE.startTrack,
      EXPECTED_FIRST_FILE.startSector,
    );
    const fileLoad = runBasicCommand(
      scheduler,
      memory,
      c64Cpu,
      drive,
      LOAD_FIRST_FILE_COMMAND,
      'LOAD"*",8,1',
    );
    assertLoadedFile(memory, firstFile);

    runBasicCommand(scheduler, memory, c64Cpu, drive, NEW_COMMAND, 'NEW before SAVE test');
    const programEntry = enterBasicProgramLine(
      scheduler,
      memory,
      c64Cpu,
      drive,
      ENTER_SAVE_PROGRAM_COMMAND,
      EXPECTED_SAVED_BASIC_FILE,
    );
    assertBasicProgramInMemory(memory, EXPECTED_SAVED_BASIC_FILE);
    const fileSave = runBasicCommand(
      scheduler,
      memory,
      c64Cpu,
      drive,
      SAVE_TEST_FILE_COMMAND,
      'SAVE"CODEX",8',
    );
    const commit = drive.mechanism.commitRawTrackWritesToD64Sectors();
    if (commit.failures.length !== 0 || commit.remainingDirtyHalfTracks.length !== 0) {
      throw new Error(`1541 SAVE produced D64-incompatible raw tracks: ${JSON.stringify(commit)}.`);
    }
    if (commit.committedHalfTracks.length === 0) {
      throw new Error('1541 SAVE returned without writing any D64 track.');
    }
    const savedFile = extractNamedD64File(disk.toBytes(false), SAVED_TEST_FILE_NAME);
    assertBytesEqual(savedFile, EXPECTED_SAVED_BASIC_FILE, 'Saved CODEX PRG');

    runBasicCommand(scheduler, memory, c64Cpu, drive, NEW_COMMAND, 'NEW before saved-file LOAD');
    const savedFileLoad = runBasicCommand(
      scheduler,
      memory,
      c64Cpu,
      drive,
      LOAD_SAVED_FILE_COMMAND,
      'LOAD"CODEX",8',
    );
    assertBasicProgramInMemory(memory, EXPECTED_SAVED_BASIC_FILE);
    const formatReference = runViceFormatReference(firmware, driveRom, formatDiskBytes);
    const writeProtectReference = runViceWriteProtectReference(
      firmware,
      driveRom,
      writeProtectDiskBytes,
      writeProtectProgramBytes,
    );
    const diskChangeReference = runViceDiskChangeReference(
      firmware,
      driveRom,
      diskChangeDiskBytes,
      diskChangeProgramBytes,
    );
    const hlsReferences = DRIVE_HLS_TEST.selectedTracks.map((selectedTrack) =>
      runViceHlsReference(
        firmware,
        driveRom,
        hlsDiskBytes,
        hlsProgramBytes,
        hlsLowTrackExpected,
        hlsHighTrackExpected,
        selectedTrack,
      ),
    );

    console.log(
      `PASS Commodore 1541-II ${DRIVE_ROM_ASSET.fileName}: BASIC READY in ${bootFrames} PAL ` +
        `frames; directory in ${directory.frames}; first PRG (${firstFile.length - 2} bytes) ` +
        `in ${fileLoad.frames}; ${iecTransitions.toLocaleString('en-US')} IEC transitions; ` +
        `drive PC=$${hex(drive.cpu.pc, 4)}, head track ${drive.mechanism.currentTrack}.`,
    );
    console.log(
      `PASS 1541 D64 write path: SAVE in ${fileSave.frames} PAL frames; committed half-tracks ` +
        `${commit.committedHalfTracks.join(', ')}; reloaded exact ${savedFile.length}-byte PRG ` +
        `in ${savedFileLoad.frames} frames (BASIC line entered in ${programEntry.frames}).`,
    );
    console.log(
      `PASS VICE drive/format/format.prg revision ${VICE_TEST_REVISION}: BASIC READY in ` +
        `${formatReference.bootFrames} PAL frames; loaded in ${formatReference.loadFrames}; ` +
        `formatted, saved and returned in ${formatReference.runFrames}; committed ` +
        `${formatReference.committedTrackCount} tracks and recovered the exact ` +
        `${formatReference.programByteLength}-byte FORMAT PRG.`,
    );
    console.log(writeProtectPassMessage(writeProtectReference));
    console.log(diskChangePassMessage(diskChangeReference));
    console.log(hlsPassMessage(hlsReferences));
    console.log(
      `PASS VICE 1541 disk fixture revision ${VICE_TEST_REVISION}: real DOS ROM, IEC, GCR, ` +
        'D64 directory, KERNAL LOAD, SAVE, format, write protection and read-back paths.',
    );
  } finally {
    stopObservingIec();
    drive.dispose();
  }
}

await main();
