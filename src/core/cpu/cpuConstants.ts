// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CPU 状态与向量常量
//
//   文件:       cpuConstants.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const enum CpuStatusFlag {
  Carry = 1 << 0,
  Zero = 1 << 1,
  InterruptDisable = 1 << 2,
  Decimal = 1 << 3,
  Break = 1 << 4,
  Unused = 1 << 5,
  Overflow = 1 << 6,
  Negative = 1 << 7,
}

export const CPU_VECTOR = {
  nonMaskableInterrupt: 0xfffa,
  reset: 0xfffc,
  interruptRequest: 0xfffe,
} as const;

export const CPU_RESET_STATE = {
  stackPointer: 0xff,
} as const;
