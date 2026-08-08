// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 PLA 地址译码
//
//   文件:       C64Pla.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { word } from '../../shared/numbers';
import { C64_MEMORY_LAYOUT, PROCESSOR_PORT_BIT } from './memoryLayout';

// PLA 同时观察 6510 处理器端口的三个存储器控制脚，以及卡带口的
// /GAME、/EXROM 电平。布尔值描述物理线电平，避免把低有效信号误写成反逻辑。
export interface C64PlaInputs {
  readonly exromLineHigh: boolean;
  readonly gameLineHigh: boolean;
  readonly processorPort: number;
}

export const C64_CARTRIDGE_MODE = {
  detached: 'detached',
  game8K: 'game8K',
  game16K: 'game16K',
  ultimax: 'ultimax',
} as const;

export type C64CartridgeMode = (typeof C64_CARTRIDGE_MODE)[keyof typeof C64_CARTRIDGE_MODE];

// 数字编码仅用于紧凑的 256 页查找表。业务代码始终使用具名常量，
// 不直接依赖数字，从而保留每个 PLA 输出的硬件含义。
export const C64_PLA_TARGET = {
  ram: 0,
  basicRom: 1,
  kernalRom: 2,
  characterRom: 3,
  io: 4,
  cartridgeLow: 5,
  cartridgeHigh: 6,
  openBus: 7,
} as const;

export type C64PlaTarget = (typeof C64_PLA_TARGET)[keyof typeof C64_PLA_TARGET];

const PROCESSOR_PORT_BANK_MASK =
  PROCESSOR_PORT_BIT.basicRom | PROCESSOR_PORT_BIT.kernalRom | PROCESSOR_PORT_BIT.characterIoSelect;
const CARTRIDGE_GAME_CONFIGURATION_BIT = 1 << 4;
const CARTRIDGE_EXROM_CONFIGURATION_BIT = 1 << 3;

export function c64CartridgeModeForLines(
  gameLineHigh: boolean,
  exromLineHigh: boolean,
): C64CartridgeMode {
  if (gameLineHigh && exromLineHigh) return C64_CARTRIDGE_MODE.detached;
  if (gameLineHigh) return C64_CARTRIDGE_MODE.game8K;
  if (!exromLineHigh) return C64_CARTRIDGE_MODE.game16K;
  return C64_CARTRIDGE_MODE.ultimax;
}

export function c64PlaConfigurationCode(inputs: C64PlaInputs): number {
  return c64PlaConfigurationCodeForSignals(
    inputs.gameLineHigh,
    inputs.exromLineHigh,
    inputs.processorPort,
  );
}

export function c64PlaConfigurationCodeForSignals(
  gameLineHigh: boolean,
  exromLineHigh: boolean,
  processorPort: number,
): number {
  return (
    (gameLineHigh ? 0 : CARTRIDGE_GAME_CONFIGURATION_BIT) |
    (exromLineHigh ? 0 : CARTRIDGE_EXROM_CONFIGURATION_BIT) |
    (processorPort & PROCESSOR_PORT_BANK_MASK)
  );
}

export class C64Pla {
  private readonly readMap = new Uint8Array(C64_MEMORY_LAYOUT.addressSpace.pageCount);
  private readonly writeMap = new Uint8Array(C64_MEMORY_LAYOUT.addressSpace.pageCount);
  private configurationCodeValue = -1;
  private cartridgeModeValue: C64CartridgeMode = C64_CARTRIDGE_MODE.detached;

  constructor(inputs: C64PlaInputs) {
    this.configure(inputs);
  }

  get configurationCode(): number {
    return this.configurationCodeValue;
  }

  get cartridgeMode(): C64CartridgeMode {
    return this.cartridgeModeValue;
  }

  configure(inputs: C64PlaInputs): void {
    const processorPort = inputs.processorPort & PROCESSOR_PORT_BANK_MASK;
    this.configurationCodeValue = c64PlaConfigurationCode(inputs);
    this.cartridgeModeValue = c64CartridgeModeForLines(inputs.gameLineHigh, inputs.exromLineHigh);

    this.readMap.fill(C64_PLA_TARGET.ram);
    this.writeMap.fill(C64_PLA_TARGET.ram);

    if (this.cartridgeModeValue === C64_CARTRIDGE_MODE.ultimax) {
      this.configureUltimaxMap();
      return;
    }

    const loram = (processorPort & PROCESSOR_PORT_BIT.basicRom) !== 0;
    const hiram = (processorPort & PROCESSOR_PORT_BIT.kernalRom) !== 0;
    const charen = (processorPort & PROCESSOR_PORT_BIT.characterIoSelect) !== 0;
    const romControlEnabled = loram || hiram;
    const basicAndRomLowEnabled = loram && hiram;

    if (
      basicAndRomLowEnabled &&
      (this.cartridgeModeValue === C64_CARTRIDGE_MODE.game8K ||
        this.cartridgeModeValue === C64_CARTRIDGE_MODE.game16K)
    ) {
      this.mapReadPages(0x80, 0x9f, C64_PLA_TARGET.cartridgeLow);
    }

    if (this.cartridgeModeValue === C64_CARTRIDGE_MODE.game16K && hiram) {
      this.mapReadPages(
        C64_MEMORY_LAYOUT.basicRom.firstPage,
        C64_MEMORY_LAYOUT.basicRom.lastPage,
        C64_PLA_TARGET.cartridgeHigh,
      );
    } else if (basicAndRomLowEnabled) {
      this.mapReadPages(
        C64_MEMORY_LAYOUT.basicRom.firstPage,
        C64_MEMORY_LAYOUT.basicRom.lastPage,
        C64_PLA_TARGET.basicRom,
      );
    }

    if (romControlEnabled) {
      const d000Target = charen ? C64_PLA_TARGET.io : C64_PLA_TARGET.characterRom;
      this.mapReadPages(
        C64_MEMORY_LAYOUT.characterRom.firstPage,
        C64_MEMORY_LAYOUT.characterRom.lastPage,
        d000Target,
      );
      if (charen) {
        this.mapWritePages(
          C64_MEMORY_LAYOUT.characterRom.firstPage,
          C64_MEMORY_LAYOUT.characterRom.lastPage,
          C64_PLA_TARGET.io,
        );
      }
    }

    if (hiram) {
      this.mapReadPages(
        C64_MEMORY_LAYOUT.kernalRom.firstPage,
        C64_MEMORY_LAYOUT.kernalRom.lastPage,
        C64_PLA_TARGET.kernalRom,
      );
    }
  }

  readTarget(address: number): C64PlaTarget {
    return this.targetForPage(this.readMap, word(address) >>> 8);
  }

  writeTarget(address: number): C64PlaTarget {
    return this.targetForPage(this.writeMap, word(address) >>> 8);
  }

  readTargetForPage(page: number): C64PlaTarget {
    return this.targetForPage(this.readMap, page);
  }

  writeTargetForPage(page: number): C64PlaTarget {
    return this.targetForPage(this.writeMap, page);
  }

  private configureUltimaxMap(): void {
    // C64 的 Ultimax 模式仍保留最低 4 KiB RAM；中间地址没有芯片驱动数据总线。
    this.mapReadWritePages(0x10, 0x7f, C64_PLA_TARGET.openBus);
    this.mapReadWritePages(0x80, 0x9f, C64_PLA_TARGET.cartridgeLow);
    this.mapReadWritePages(0xa0, 0xcf, C64_PLA_TARGET.openBus);
    this.mapReadWritePages(0xd0, 0xdf, C64_PLA_TARGET.io);
    this.mapReadWritePages(0xe0, 0xff, C64_PLA_TARGET.cartridgeHigh);
  }

  private mapReadPages(firstPage: number, lastPage: number, target: C64PlaTarget): void {
    this.mapPages(this.readMap, firstPage, lastPage, target);
  }

  private mapWritePages(firstPage: number, lastPage: number, target: C64PlaTarget): void {
    this.mapPages(this.writeMap, firstPage, lastPage, target);
  }

  private mapReadWritePages(firstPage: number, lastPage: number, target: C64PlaTarget): void {
    this.mapReadPages(firstPage, lastPage, target);
    this.mapWritePages(firstPage, lastPage, target);
  }

  private mapPages(
    map: Uint8Array,
    firstPage: number,
    lastPage: number,
    target: C64PlaTarget,
  ): void {
    for (let page = firstPage; page <= lastPage; page += 1) map[page] = target;
  }

  private targetForPage(map: Uint8Array, page: number): C64PlaTarget {
    if (!Number.isInteger(page) || page < 0 || page >= map.length) {
      throw new RangeError(`C64 PLA page ${page} is outside the 256-page address space.`);
    }
    const target = map[page];
    if (target === undefined || target > C64_PLA_TARGET.openBus) {
      throw new RangeError(`C64 PLA page ${page} contains invalid target ${String(target)}.`);
    }
    return target as C64PlaTarget;
  }
}
