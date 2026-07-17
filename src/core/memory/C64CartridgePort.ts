// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 扩展卡带端口
//
//   文件:       C64CartridgePort.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// null 表示卡带处于高阻态，没有器件驱动数据总线。这是硬件信号状态，
// 与用任意默认字节掩盖缺失实现不同；整机总线会改为读取 VIC-II φ1 数据。
export type C64CartridgeReadResult = number | null;

export interface C64CartridgePort {
  readonly exromLineHigh: boolean;
  readonly gameLineHigh: boolean;
  /** 扩展口 4 脚的低有效 /IRQ 信号。 */
  readonly irqLineLow: boolean;
  /** 扩展口 D 脚的低有效 /NMI 信号。 */
  readonly nmiLineLow: boolean;

  readIo1(address: number): C64CartridgeReadResult;
  readIo2(address: number): C64CartridgeReadResult;
  readRomHigh(address: number): C64CartridgeReadResult;
  readRomLow(address: number): C64CartridgeReadResult;
  reset(): void;
  /** 推进扩展口设备的主机时钟；非时序型卡带保持空实现。 */
  tick(cycles: number): void;
  writeIo1(address: number, value: number): void;
  writeIo2(address: number, value: number): void;
  writeRomHigh(address: number, value: number): void;
  writeRomLow(address: number, value: number): void;
}

// 空扩展口的两根控制线由上拉电阻维持高电平，所有数据引脚均为高阻态。
export class DisconnectedC64CartridgePort implements C64CartridgePort {
  readonly exromLineHigh = true;
  readonly gameLineHigh = true;
  readonly irqLineLow = false;
  readonly nmiLineLow = false;

  readIo1(): null {
    return null;
  }

  readIo2(): null {
    return null;
  }

  readRomHigh(): null {
    return null;
  }

  readRomLow(): null {
    return null;
  }

  reset(): void {
    // 空端口没有可复位状态。
  }

  tick(): void {
    // 空端口没有时钟驱动器件。
  }

  writeIo1(): void {
    // 高阻态设备不会接收写入。
  }

  writeIo2(): void {
    // 高阻态设备不会接收写入。
  }

  writeRomHigh(): void {
    // 高阻态设备不会接收写入。
  }

  writeRomLow(): void {
    // 高阻态设备不会接收写入。
  }
}
