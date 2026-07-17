// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Ocean 分页游戏卡带
//
//   文件:       OceanCartridge.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';
import { BankedCartridgeRom } from './BankedCartridgeRom';
import type { C64CartridgePort } from './C64CartridgePort';

export const OCEAN_CARTRIDGE_BANK_COUNTS = [4, 16, 32, 64] as const;

export interface OceanCartridgeOptions {
  readonly romBanks: readonly Uint8Array[];
}

/**
 * Ocean Type A/B 卡带。IO1 的六位寄存器选择 8 KiB bank；64-bank Type B 使用 8K
 * GAME，其余已知尺寸使用 16K GAME，并让同一个 bank 同时驱动 ROML 与 ROMH。
 */
export class OceanCartridge implements C64CartridgePort {
  readonly exromLineHigh = false;
  readonly gameLineHigh: boolean;
  readonly irqLineLow = false;
  readonly nmiLineLow = false;

  private readonly bankMask: number;
  private readonly rom: BankedCartridgeRom;
  private selectedBankValue = 0;

  constructor(options: OceanCartridgeOptions) {
    this.rom = new BankedCartridgeRom('Ocean cartridge', options.romBanks);
    if (!isOceanBankCount(this.rom.bankCount)) {
      throw new RangeError(
        `Ocean cartridge requires 4, 16, 32, or 64 ROM banks; received ${this.rom.bankCount}.`,
      );
    }
    this.bankMask = this.rom.bankCount - 1;
    this.gameLineHigh = this.rom.bankCount === 64;
  }

  get selectedBank(): number {
    return this.selectedBankValue;
  }

  readIo1(): null {
    // 74LS273 bank latch没有把输出接回数据总线，IO1 读周期保持高阻态。
    return null;
  }

  readIo2(): null {
    return null;
  }

  readRomHigh(address: number): number | null {
    if (this.gameLineHigh) return null;
    return this.rom.read(this.selectedBankValue, address);
  }

  readRomLow(address: number): number {
    return this.rom.read(this.selectedBankValue, address);
  }

  reset(): void {
    this.selectedBankValue = 0;
  }

  tick(): void {
    // Ocean 的 bank 锁存器在写周期结束时同步更新，没有后台时序状态。
  }

  writeIo1(address: number, value: number): void {
    requireOceanIo1Address(address);
    this.selectedBankValue = byte(value) & this.bankMask;
  }

  writeIo2(): void {
    // Ocean 卡带未译码 IO2。
  }

  writeRomHigh(): void {
    // 掩膜 ROM 忽略写周期。
  }

  writeRomLow(): void {
    // 掩膜 ROM 忽略写周期。
  }
}

function isOceanBankCount(value: number): value is (typeof OCEAN_CARTRIDGE_BANK_COUNTS)[number] {
  return OCEAN_CARTRIDGE_BANK_COUNTS.some((count) => count === value);
}

function requireOceanIo1Address(address: number): void {
  if (Number.isInteger(address) && address >= 0xde00 && address <= 0xdeff) return;
  throw new RangeError(`Ocean IO1 address must be from $de00 through $deff; received ${address}.`);
}
