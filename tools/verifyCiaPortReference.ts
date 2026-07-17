// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA1 键盘端口外部参考验证器
//
//   文件:       verifyCiaPortReference.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

interface CiaPortReferenceScenario {
  readonly expected: readonly number[];
  readonly keys: readonly string[];
  readonly name: string;
}

const VICE_TEST_REVISION = 46_176;
const REFERENCE_FILE = 'ciaports.prg';
const REFERENCE_SHA256 = '00b9ffdcab013e619ef7a9d703e5157b83dead53d0cd0e998b024b3f75511036';
const REFERENCE_URL =
  `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
  `testprogs/CIA/ciaports/${REFERENCE_FILE}?format=raw`;
const CACHE_PATH = resolve(`output/reference/${REFERENCE_FILE}`);
const PROGRAM_ENTRY_ADDRESS = 0x080d;
const EXECUTION_FRAME_COUNT = 4;
const RESULT_SCREEN_ROWS = [3, 4, 5, 6, 7, 8, 9] as const;
const PORT_A_HEX_COLUMN = 10;
const PORT_B_HEX_COLUMN = 14;
const SCREEN_ROW_WIDTH = 40;

const REFERENCE_SCENARIOS: readonly CiaPortReferenceScenario[] = [
  {
    expected: [0x00, 0xef, 0x7f, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0x7f, 0x00, 0xff, 0xff],
    keys: ['Space'],
    name: 'SPACE',
  },
  {
    expected: [0x00, 0x7f, 0xfd, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0xfd, 0x00, 0xff, 0xff],
    keys: ['ShiftLeft'],
    name: 'left SHIFT',
  },
  {
    expected: [0x00, 0xef, 0xbf, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0xbf, 0x00, 0xff, 0xff],
    keys: ['ShiftRight'],
    name: 'right SHIFT',
  },
  {
    expected: [0x00, 0x6f, 0xbd, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff, 0xbd, 0x00, 0xff, 0xff],
    keys: ['ShiftLeft', 'ShiftRight'],
    name: 'both SHIFT keys',
  },
  {
    expected: [0x00, 0x7f, 0xfd, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x7f, 0xfd, 0x00, 0xff, 0xff],
    keys: ['ShiftLock'],
    name: 'SHIFT LOCK',
  },
  {
    expected: [0x00, 0x6f, 0xbd, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x7f, 0xbd, 0x00, 0xff, 0xff],
    keys: ['ShiftLock', 'ShiftRight'],
    name: 'SHIFT LOCK plus right SHIFT',
  },
];

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

async function loadReferenceProgram(): Promise<Uint8Array> {
  try {
    const cached = new Uint8Array(await readFile(CACHE_PATH));
    if (sha256(cached) === REFERENCE_SHA256) return cached;
  } catch {
    // 首次运行时没有本地参考缓存，继续走固定地址下载路径。
  }

  const response = await fetch(REFERENCE_URL);
  if (!response.ok) {
    throw new Error(`Unable to download the VICE CIA port test: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const actualHash = sha256(downloaded);
  if (actualHash !== REFERENCE_SHA256) {
    throw new Error(`VICE CIA port test SHA-256 mismatch: received ${actualHash}.`);
  }
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, downloaded);
  return downloaded;
}

function decodeScreenNibble(screenCode: number): number {
  if (screenCode >= 0x30 && screenCode <= 0x39) return screenCode - 0x30;
  if (screenCode >= 0x01 && screenCode <= 0x06) return screenCode + 9;
  throw new Error(
    `Unexpected hexadecimal screen code $${screenCode.toString(16).padStart(2, '0')}.`,
  );
}

function readScreenByte(memory: C64Memory, row: number, column: number): number {
  const address = 0x0400 + row * SCREEN_ROW_WIDTH + column;
  const high = decodeScreenNibble(memory.ram[address] ?? 0);
  const low = decodeScreenNibble(memory.ram[address + 1] ?? 0);
  return (high << 4) | low;
}

function readResultVector(memory: C64Memory): readonly number[] {
  return RESULT_SCREEN_ROWS.flatMap((row) => [
    readScreenByte(memory, row, PORT_A_HEX_COLUMN),
    readScreenByte(memory, row, PORT_B_HEX_COLUMN),
  ]);
}

function formatVector(vector: readonly number[]): string {
  return vector.map((value) => value.toString(16).padStart(2, '0')).join(' ');
}

function runScenario(
  firmware: C64Firmware,
  program: Uint8Array,
  scenario: CiaPortReferenceScenario,
): void {
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.none });
  cpu.pc = PROGRAM_ENTRY_ADDRESS;
  for (const key of scenario.keys) memory.cia1.keyboard.setKeyState(key, true);
  for (let frame = 0; frame < EXECUTION_FRAME_COUNT; frame += 1) scheduler.runFrame();

  const actual = readResultVector(memory);
  if (
    actual.length !== scenario.expected.length ||
    actual.some((value, index) => value !== scenario.expected[index])
  ) {
    throw new Error(
      `VICE ${REFERENCE_FILE} ${scenario.name} mismatch: ` +
        `received ${formatVector(actual)}, expected ${formatVector(scenario.expected)}.`,
    );
  }
}

async function main(): Promise<void> {
  const [firmware, program] = await Promise.all([loadFirmware(), loadReferenceProgram()]);
  for (const scenario of REFERENCE_SCENARIOS) runScenario(firmware, program, scenario);
  console.log(
    `PASS VICE ${REFERENCE_FILE} revision ${VICE_TEST_REVISION}: ` +
      `${REFERENCE_SCENARIOS.length} real-machine CIA1 keyboard-port vectors.`,
  );
}

await main();
