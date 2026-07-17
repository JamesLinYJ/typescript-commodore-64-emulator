// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - EasyFlash 可编程卡带
//
//   文件:       EasyFlashCartridge.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';
import { Amd29F040BFlash, AMD_29F040B_FLASH_LAYOUT } from './Amd29F040BFlash';
import type { C64CartridgePort } from './C64CartridgePort';
import { C64_CARTRIDGE_MODE, type C64CartridgeMode } from './C64Pla';

export const EASY_FLASH_LAYOUT = {
  bankCount: 64,
  bankMask: 0x3f,
  bankSizeBytes: 0x2000,
  io1EndAddress: 0xdeff,
  io1StartAddress: 0xde00,
  io2EndAddress: 0xdfff,
  io2RamSizeBytes: 0x100,
  io2StartAddress: 0xdf00,
  modeRegisterMask: 0x87,
} as const;

const EASY_FLASH_MODE_TABLE: readonly C64CartridgeMode[] = [
  C64_CARTRIDGE_MODE.ultimax,
  C64_CARTRIDGE_MODE.ultimax,
  C64_CARTRIDGE_MODE.game16K,
  C64_CARTRIDGE_MODE.game16K,
  C64_CARTRIDGE_MODE.detached,
  C64_CARTRIDGE_MODE.ultimax,
  C64_CARTRIDGE_MODE.game8K,
  C64_CARTRIDGE_MODE.game16K,
  C64_CARTRIDGE_MODE.detached,
  C64_CARTRIDGE_MODE.ultimax,
  C64_CARTRIDGE_MODE.game8K,
  C64_CARTRIDGE_MODE.game16K,
  C64_CARTRIDGE_MODE.detached,
  C64_CARTRIDGE_MODE.ultimax,
  C64_CARTRIDGE_MODE.game8K,
  C64_CARTRIDGE_MODE.game16K,
];

const EASY_FLASH_MODE_BIT = {
  jumper: 1 << 3,
  led: 1 << 7,
  registerSelect: 1 << 1,
} as const;

export interface EasyFlashCartridgeOptions {
  readonly flashHigh: Uint8Array;
  readonly flashLow: Uint8Array;
  readonly io2Ram?: Uint8Array;
  readonly jumperInstalled?: boolean;
}

/** 两颗 AM29F040B、bank/mode 锁存器和可寻址 IO2 SRAM 组成的 EasyFlash 1。 */
export class EasyFlashCartridge implements C64CartridgePort {
  readonly flashHigh: Amd29F040BFlash;
  readonly flashLow: Amd29F040BFlash;
  readonly irqLineLow = false;
  readonly nmiLineLow = false;

  private readonly io2Ram: Uint8Array;
  private readonly jumperInstalledValue: boolean;
  private modeRegisterValue = 0;
  private selectedBankValue = 0;

  constructor(options: EasyFlashCartridgeOptions) {
    this.flashHigh = new Amd29F040BFlash(options.flashHigh);
    this.flashLow = new Amd29F040BFlash(options.flashLow);
    this.jumperInstalledValue = options.jumperInstalled ?? false;
    this.io2Ram = createIo2Ram(options.io2Ram);
  }

  get cartridgeMode(): C64CartridgeMode {
    const index =
      (this.jumperInstalledValue ? EASY_FLASH_MODE_BIT.jumper : 0) |
      (this.modeRegisterValue & 0x07);
    const mode = EASY_FLASH_MODE_TABLE[index];
    if (!mode) throw new Error(`EasyFlash mode-table invariant failed at index ${index}.`);
    return mode;
  }

  get exromLineHigh(): boolean {
    const mode = this.cartridgeMode;
    return mode === C64_CARTRIDGE_MODE.detached || mode === C64_CARTRIDGE_MODE.ultimax;
  }

  get gameLineHigh(): boolean {
    const mode = this.cartridgeMode;
    return mode === C64_CARTRIDGE_MODE.detached || mode === C64_CARTRIDGE_MODE.game8K;
  }

  get jumperInstalled(): boolean {
    return this.jumperInstalledValue;
  }

  get ledOn(): boolean {
    return (this.modeRegisterValue & EASY_FLASH_MODE_BIT.led) !== 0;
  }

  get modeRegister(): number {
    return this.modeRegisterValue;
  }

  get selectedBank(): number {
    return this.selectedBankValue;
  }

  readIo1(address: number): null {
    requireEasyFlashIo1Address(address);
    // 两个锁存器为写专用，没有输出缓冲连接到 C64 数据总线。
    return null;
  }

  readIo2(address: number): number {
    requireEasyFlashIo2Address(address);
    return this.io2Ram[address & 0xff]!;
  }

  readRomHigh(address: number): number {
    return this.flashHigh.read(this.flashAddress(address));
  }

  readRomLow(address: number): number {
    return this.flashLow.read(this.flashAddress(address));
  }

  reset(): void {
    this.selectedBankValue = 0;
    this.modeRegisterValue = 0;
    // C64 /RESET 只接到 EasyFlash 的寄存器逻辑；两颗 Flash 没有由该信号驱动的复位脚，
    // 因此正在进行的命令和非易失数据都继续保留。
  }

  tick(cycles: number): void {
    this.flashLow.tick(cycles);
    this.flashHigh.tick(cycles);
  }

  writeIo1(address: number, value: number): void {
    requireEasyFlashIo1Address(address);
    const normalizedValue = byte(value);
    if ((address & EASY_FLASH_MODE_BIT.registerSelect) === 0) {
      this.selectedBankValue = normalizedValue & EASY_FLASH_LAYOUT.bankMask;
      return;
    }
    this.modeRegisterValue = normalizedValue & EASY_FLASH_LAYOUT.modeRegisterMask;
  }

  writeIo2(address: number, value: number): void {
    requireEasyFlashIo2Address(address);
    this.io2Ram[address & 0xff] = byte(value);
  }

  writeRomHigh(address: number, value: number): void {
    this.flashHigh.write(this.flashAddress(address), value);
  }

  writeRomLow(address: number, value: number): void {
    this.flashLow.write(this.flashAddress(address), value);
  }

  private flashAddress(address: number): number {
    if (!Number.isSafeInteger(address) || address < 0 || address > 0xffff) {
      throw new RangeError(`EasyFlash ROM address must be a 16-bit integer; received ${address}.`);
    }
    return (
      this.selectedBankValue * EASY_FLASH_LAYOUT.bankSizeBytes +
      (address & (EASY_FLASH_LAYOUT.bankSizeBytes - 1))
    );
  }
}

function createIo2Ram(initialData: Uint8Array | undefined): Uint8Array {
  if (initialData) {
    if (initialData.length !== EASY_FLASH_LAYOUT.io2RamSizeBytes) {
      throw new RangeError(
        `EasyFlash IO2 RAM must contain ${EASY_FLASH_LAYOUT.io2RamSizeBytes} bytes; ` +
          `received ${initialData.length}.`,
      );
    }
    return initialData.slice();
  }

  // SRAM 上电内容没有稳定硬件保证；选用固定 $FF 保证回归可复现，软复位不会重填。
  return new Uint8Array(EASY_FLASH_LAYOUT.io2RamSizeBytes).fill(0xff);
}

function requireEasyFlashIo1Address(address: number): void {
  if (
    Number.isSafeInteger(address) &&
    address >= EASY_FLASH_LAYOUT.io1StartAddress &&
    address <= EASY_FLASH_LAYOUT.io1EndAddress
  ) {
    return;
  }
  throw new RangeError(
    `EasyFlash IO1 address must be from $de00 through $deff; received ${address}.`,
  );
}

function requireEasyFlashIo2Address(address: number): void {
  if (
    Number.isSafeInteger(address) &&
    address >= EASY_FLASH_LAYOUT.io2StartAddress &&
    address <= EASY_FLASH_LAYOUT.io2EndAddress
  ) {
    return;
  }
  throw new RangeError(
    `EasyFlash IO2 address must be from $df00 through $dfff; received ${address}.`,
  );
}

if (
  EASY_FLASH_LAYOUT.bankCount * EASY_FLASH_LAYOUT.bankSizeBytes !==
  AMD_29F040B_FLASH_LAYOUT.capacityBytes
) {
  throw new Error('EasyFlash bank geometry does not match AM29F040B capacity.');
}
