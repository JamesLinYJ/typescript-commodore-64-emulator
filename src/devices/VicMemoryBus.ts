// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 内存总线端口
//
//   文件:       VicMemoryBus.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const VIC_MEMORY_LAYOUT = {
  bank: {
    addressMask: 0x3fff,
    size: 0x4000,
  },
  characterRomWindow: {
    addressMask: 0x7000,
    addressValue: 0x1000,
    localOffsetMask: 0x0fff,
  },
  colorRam: {
    addressMask: 0x03ff,
  },
} as const;

// 地址参数始终是 VIC-II 看到的 14 位局部地址；CIA2 选库与字符 ROM
// 窗口映射由整机内存总线实现，设备本身不依赖 C64Memory。
export interface VicMemoryBus {
  readonly cpuDataBusValue: number;
  readVicByte(addressInBank: number): number;
  readVicColor(index: number): number;
}
