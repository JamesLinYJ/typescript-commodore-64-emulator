// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 卡带分页只读存储器
//
//   文件:       BankedCartridgeRom.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';

export const BANKED_CARTRIDGE_ROM_LAYOUT = {
  addressMask: 0x1fff,
  bankSize: 0x2000,
} as const;

/**
 * 保存彼此独立的 8 KiB ROM bank。分页寄存器和 GAME/EXROM 组合属于具体卡带电路，
 * 本类只负责不可变镜像、边界验证与地址脚译码，避免不同 mapper 复制存储算法。
 */
export class BankedCartridgeRom {
  private readonly bankImages: readonly Uint8Array[];

  constructor(deviceName: string, banks: readonly Uint8Array[]) {
    if (banks.length === 0) throw new RangeError(`${deviceName} requires at least one ROM bank.`);
    this.bankImages = banks.map((bank, index) => {
      if (bank.length !== BANKED_CARTRIDGE_ROM_LAYOUT.bankSize) {
        throw new RangeError(
          `${deviceName} ROM bank ${index} must contain ` +
            `${BANKED_CARTRIDGE_ROM_LAYOUT.bankSize} bytes; received ${bank.length}.`,
        );
      }
      return bank.slice();
    });
  }

  get bankCount(): number {
    return this.bankImages.length;
  }

  read(bank: number, address: number): number {
    if (!Number.isInteger(bank) || bank < 0 || bank >= this.bankImages.length) {
      throw new RangeError(
        `Cartridge ROM bank must be from 0 through ${this.bankImages.length - 1}; received ${bank}.`,
      );
    }
    const image = this.bankImages[bank];
    const value = image?.[address & BANKED_CARTRIDGE_ROM_LAYOUT.addressMask];
    if (value === undefined) {
      throw new RangeError(
        `Cartridge ROM address $${address.toString(16)} is outside bank ${bank}.`,
      );
    }
    return byte(value);
  }
}
