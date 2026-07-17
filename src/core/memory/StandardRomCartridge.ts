// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 标准 ROM 卡带
//
//   文件:       StandardRomCartridge.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';
import type { C64CartridgePort } from './C64CartridgePort';
import { C64_CARTRIDGE_MODE } from './C64Pla';

export const STANDARD_CARTRIDGE_ROM_LAYOUT = {
  addressMask: 0x1fff,
  bankSize: 0x2000,
} as const;

export interface Standard8KRomCartridgeOptions {
  readonly mode: typeof C64_CARTRIDGE_MODE.game8K;
  readonly romLow: Uint8Array;
}

export interface Standard16KRomCartridgeOptions {
  readonly mode: typeof C64_CARTRIDGE_MODE.game16K;
  readonly romHigh: Uint8Array;
  readonly romLow: Uint8Array;
}

export interface StandardUltimaxRomCartridgeOptions {
  readonly mode: typeof C64_CARTRIDGE_MODE.ultimax;
  readonly romHigh: Uint8Array;
  readonly romLow: Uint8Array;
}

export type StandardRomCartridgeOptions =
  | Standard8KRomCartridgeOptions
  | Standard16KRomCartridgeOptions
  | StandardUltimaxRomCartridgeOptions;

export class StandardRomCartridge implements C64CartridgePort {
  readonly exromLineHigh: boolean;
  readonly gameLineHigh: boolean;
  readonly irqLineLow = false;
  readonly nmiLineLow = false;
  private readonly romHigh: Uint8Array | null;
  private readonly romLow: Uint8Array;

  constructor(options: StandardRomCartridgeOptions) {
    this.assertRomSize('ROML', options.romLow);
    this.romLow = options.romLow.slice();

    if (options.mode === C64_CARTRIDGE_MODE.game8K) {
      this.gameLineHigh = true;
      this.exromLineHigh = false;
      this.romHigh = null;
    } else {
      this.assertRomSize('ROMH', options.romHigh);
      this.romHigh = options.romHigh.slice();
      this.gameLineHigh = false;
      this.exromLineHigh = options.mode === C64_CARTRIDGE_MODE.ultimax;
    }
  }

  readIo1(): null {
    return null;
  }

  readIo2(): null {
    return null;
  }

  readRomHigh(address: number): number | null {
    if (this.romHigh === null) return null;
    return this.readRom(this.romHigh, address);
  }

  readRomLow(address: number): number {
    return this.readRom(this.romLow, address);
  }

  reset(): void {
    // 无分页寄存器的只读卡带没有运行期状态。
  }

  tick(): void {
    // 掩膜 ROM 与无源译码逻辑没有需要推进的时序状态。
  }

  writeIo1(): void {
    // 标准 ROM 卡带未译码 IO1。
  }

  writeIo2(): void {
    // 标准 ROM 卡带未译码 IO2。
  }

  writeRomHigh(): void {
    // ROM 芯片忽略写周期；Ultimax 下也不会写入 C64 主 RAM。
  }

  writeRomLow(): void {
    // ROM 芯片忽略写周期；Ultimax 下也不会写入 C64 主 RAM。
  }

  private assertRomSize(name: string, image: Uint8Array): void {
    if (image.length !== STANDARD_CARTRIDGE_ROM_LAYOUT.bankSize) {
      throw new RangeError(
        `${name} must contain ${STANDARD_CARTRIDGE_ROM_LAYOUT.bankSize} bytes; received ${image.length}.`,
      );
    }
  }

  private readRom(image: Uint8Array, address: number): number {
    const value = image[address & STANDARD_CARTRIDGE_ROM_LAYOUT.addressMask];
    if (value === undefined) {
      throw new RangeError(`Cartridge ROM address ${address.toString(16)} is outside its bank.`);
    }
    return byte(value);
  }
}
