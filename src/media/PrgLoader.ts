// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - PRG 解析、RAM 注入与启动
//
//   文件:       PrgLoader.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { Cpu6502 } from '../core/cpu/Cpu6502';
import type { C64Memory } from '../core/memory/C64Memory';

export interface PrgImage {
  readonly bytes: Uint8Array;
  readonly loadAddress: number;
}

export interface LoadedProgram {
  readonly endAddress: number;
  readonly loadAddress: number;
  readonly size: number;
  readonly startMode: PrgStartMode;
}

export const PRG_START_MODE = {
  basicRun: 'basicRun',
  direct: 'direct',
  none: 'none',
} as const;

export type PrgStartMode = (typeof PRG_START_MODE)[keyof typeof PRG_START_MODE];

export interface InstallPrgOptions {
  readonly entryAddress?: number;
  readonly startMode?: PrgStartMode;
}

const C64_BASIC_AUTOSTART_LAYOUT = {
  keyboardBuffer: {
    capacityAddress: 0x0289,
    countAddress: 0x00c6,
    start: 0x0277,
  },
  textEndPointers: [0x002d, 0x002f, 0x0031, 0x00ae],
  textStart: 0x0801,
  textStartPointers: [0x002b, 0x00ac],
} as const;

// PETSCII 的 R、U、N 和回车；固定字节避免把宿主字符编码混进 C64 键盘缓冲。
const BASIC_RUN_COMMAND = Uint8Array.of(0x52, 0x55, 0x4e, 0x0d);
const C64_ADDRESS_SPACE_SIZE = 0x1_0000;

export const BASIC_PRG_LOAD_ADDRESS = C64_BASIC_AUTOSTART_LAYOUT.textStart;

export function parsePrg(input: ArrayBuffer | Uint8Array): PrgImage {
  const file = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (file.length < 2) throw new RangeError('A PRG file must include a two-byte load address.');
  const loadAddress = (file[0] ?? 0) | ((file[1] ?? 0) << 8);
  const bytes = file.slice(2);
  if (bytes.length === 0)
    throw new RangeError('A PRG file must contain at least one payload byte.');
  assertPrgRange(loadAddress, bytes.length);
  return { loadAddress, bytes };
}

export function installPrg(
  image: PrgImage,
  memory: C64Memory,
  cpu: Cpu6502,
  options: InstallPrgOptions = {},
): LoadedProgram {
  assertPrgRange(image.loadAddress, image.bytes.length);
  const endAddress = image.loadAddress + image.bytes.length;
  const startMode = requirePrgStartMode(options.startMode ?? PRG_START_MODE.none);
  const entryAddress = options.entryAddress ?? image.loadAddress;

  assertPrgStartCompatibility(image, { entryAddress, startMode });
  if (startMode === PRG_START_MODE.basicRun) validateBasicAutostart(memory, endAddress);

  memory.injectRamImage(image.loadAddress, image.bytes);

  if (startMode === PRG_START_MODE.basicRun) {
    setBasicTextRange(memory, C64_BASIC_AUTOSTART_LAYOUT.textStart, endAddress);
    queueBasicRunCommand(memory);
  } else if (startMode === PRG_START_MODE.direct) {
    cpu.pc = entryAddress;
  }

  return {
    loadAddress: image.loadAddress,
    endAddress,
    size: image.bytes.length,
    startMode,
  };
}

/**
 * 在复位、暂停或 RAM 注入之前验证启动策略。这个纯验证入口让上层控制器能原子拒绝
 * 被误选为 BASIC RUN 的机器码 PRG，不会先改变整机状态再发现装载地址不兼容。
 */
export function assertPrgStartCompatibility(
  image: PrgImage,
  options: InstallPrgOptions = {},
): void {
  const startMode = requirePrgStartMode(options.startMode ?? PRG_START_MODE.none);
  if (startMode === PRG_START_MODE.basicRun && image.loadAddress !== BASIC_PRG_LOAD_ADDRESS) {
    throw new Error(
      `BASIC RUN requires a PRG loaded at $${BASIC_PRG_LOAD_ADDRESS.toString(16).padStart(4, '0')}; ` +
        `this PRG loads at $${image.loadAddress.toString(16).padStart(4, '0')}. ` +
        'Choose direct execution with an explicit entry address, or load without starting.',
    );
  }
  if (startMode === PRG_START_MODE.direct) {
    assertC64Address(options.entryAddress ?? image.loadAddress, 'PRG entry');
  }
}

function assertPrgRange(loadAddress: number, size: number): void {
  assertC64Address(loadAddress, 'PRG load');
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`PRG payload size must be a positive integer; received ${size}.`);
  }
  const finalAddress = loadAddress + size - 1;
  if (finalAddress >= C64_ADDRESS_SPACE_SIZE) {
    throw new RangeError(
      `PRG range $${loadAddress.toString(16)}..$${finalAddress.toString(16)} exceeds the 64 KiB address space.`,
    );
  }
}

function assertC64Address(address: number, name: string): void {
  if (!Number.isInteger(address) || address < 0 || address >= C64_ADDRESS_SPACE_SIZE) {
    throw new RangeError(`${name} address must be a 16-bit integer; received ${address}.`);
  }
}

function requirePrgStartMode(value: unknown): PrgStartMode {
  switch (value) {
    case PRG_START_MODE.basicRun:
    case PRG_START_MODE.direct:
    case PRG_START_MODE.none:
      return value;
    default:
      throw new RangeError(`Unsupported PRG start mode ${String(value)}.`);
  }
}

function validateBasicAutostart(memory: C64Memory, endAddress: number): void {
  if (endAddress >= C64_ADDRESS_SPACE_SIZE) {
    throw new RangeError('A BASIC-autostart PRG must leave a representable 16-bit end pointer.');
  }

  const currentTextStart = readRamWord(memory, C64_BASIC_AUTOSTART_LAYOUT.textStartPointers[0]);
  if (currentTextStart !== C64_BASIC_AUTOSTART_LAYOUT.textStart) {
    throw new Error(
      `C64 BASIC is not ready for PRG injection: text start is $${currentTextStart.toString(16).padStart(4, '0')}.`,
    );
  }

  const used = memory.ram[C64_BASIC_AUTOSTART_LAYOUT.keyboardBuffer.countAddress] ?? 0;
  const capacity = memory.ram[C64_BASIC_AUTOSTART_LAYOUT.keyboardBuffer.capacityAddress] ?? 0;
  if (used > capacity) {
    throw new Error(`C64 keyboard buffer count ${used} exceeds its capacity ${capacity}.`);
  }
  if (used + BASIC_RUN_COMMAND.length > capacity) {
    throw new Error(
      `C64 keyboard buffer has ${capacity - used} free bytes; RUN requires ${BASIC_RUN_COMMAND.length}.`,
    );
  }
}

function setBasicTextRange(memory: C64Memory, startAddress: number, endAddress: number): void {
  for (const pointer of C64_BASIC_AUTOSTART_LAYOUT.textStartPointers) {
    writeRamWord(memory, pointer, startAddress);
  }
  for (const pointer of C64_BASIC_AUTOSTART_LAYOUT.textEndPointers) {
    writeRamWord(memory, pointer, endAddress);
  }
}

function queueBasicRunCommand(memory: C64Memory): void {
  const { countAddress, start } = C64_BASIC_AUTOSTART_LAYOUT.keyboardBuffer;
  const used = memory.ram[countAddress] ?? 0;
  memory.injectRamImage(start + used, BASIC_RUN_COMMAND);
  memory.ram[countAddress] = used + BASIC_RUN_COMMAND.length;
}

function readRamWord(memory: C64Memory, address: number): number {
  return (memory.ram[address] ?? 0) | ((memory.ram[address + 1] ?? 0) << 8);
}

function writeRamWord(memory: C64Memory, address: number, value: number): void {
  memory.ram[address] = value & 0xff;
  memory.ram[address + 1] = (value >>> 8) & 0xff;
}
