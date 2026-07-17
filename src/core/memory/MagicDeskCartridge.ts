// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Magic Desk 分页卡带
//
//   文件:       MagicDeskCartridge.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';
import { BankedCartridgeRom } from './BankedCartridgeRom';
import type { C64CartridgePort } from './C64CartridgePort';

export const MAGIC_DESK_CARTRIDGE_BANK_COUNTS = [4, 8, 16, 32, 64, 128] as const;

const MAGIC_DESK_DISABLE_BIT = 1 << 7;

export interface MagicDeskCartridgeOptions {
  readonly romBanks: readonly Uint8Array[];
}

/** Magic Desk 及其常见扩容板：IO1 低七位选 bank，bit 7 释放 EXROM 并隐藏卡带。 */
export class MagicDeskCartridge implements C64CartridgePort {
  readonly gameLineHigh = true;
  readonly irqLineLow = false;
  readonly nmiLineLow = false;

  private readonly bankMask: number;
  private readonly rom: BankedCartridgeRom;
  private enabledValue = true;
  private registerValue = 0;
  private selectedBankValue = 0;

  constructor(options: MagicDeskCartridgeOptions) {
    this.rom = new BankedCartridgeRom('Magic Desk cartridge', options.romBanks);
    if (!isMagicDeskBankCount(this.rom.bankCount)) {
      throw new RangeError(
        `Magic Desk cartridge requires 4, 8, 16, 32, 64, or 128 ROM banks; ` +
          `received ${this.rom.bankCount}.`,
      );
    }
    this.bankMask = this.rom.bankCount - 1;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get exromLineHigh(): boolean {
    return !this.enabledValue;
  }

  get selectedBank(): number {
    return this.selectedBankValue;
  }

  readIo1(): null {
    // 分页锁存器只响应写周期，不驱动 IO1 读数据。
    return null;
  }

  readIo2(): null {
    return null;
  }

  readRomHigh(): null {
    return null;
  }

  readRomLow(address: number): number {
    return this.rom.read(this.selectedBankValue, address);
  }

  reset(): void {
    this.applyRegister(0);
  }

  tick(): void {
    // Magic Desk 仅含组合译码和 bank 锁存器，没有后台时序状态。
  }

  writeIo1(address: number, value: number): void {
    requireMagicDeskIo1Address(address);
    this.applyRegister(byte(value));
  }

  writeIo2(): void {
    // Magic Desk 卡带未译码 IO2。
  }

  writeRomHigh(): void {
    // 卡带没有 ROMH 芯片。
  }

  writeRomLow(): void {
    // 掩膜 ROM 忽略写周期。
  }

  private applyRegister(value: number): void {
    this.registerValue = value & (MAGIC_DESK_DISABLE_BIT | this.bankMask);
    this.selectedBankValue = this.registerValue & this.bankMask;
    this.enabledValue = (this.registerValue & MAGIC_DESK_DISABLE_BIT) === 0;
  }
}

function isMagicDeskBankCount(
  value: number,
): value is (typeof MAGIC_DESK_CARTRIDGE_BANK_COUNTS)[number] {
  return MAGIC_DESK_CARTRIDGE_BANK_COUNTS.some((count) => count === value);
}

function requireMagicDeskIo1Address(address: number): void {
  if (Number.isInteger(address) && address >= 0xde00 && address <= 0xdeff) return;
  throw new RangeError(
    `Magic Desk IO1 address must be from $de00 through $deff; received ${address}.`,
  );
}
