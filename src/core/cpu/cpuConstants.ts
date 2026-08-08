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

// NMOS 6502 上电时除 RESET 明确控制的状态外并没有软件可依赖的寄存器值。
// 模拟器仍需要可复现的构造结果，因此在执行第一次 RESET 微序列前使用固定初值。
// SP 从 $00 开始并经过三次伪压栈读，最终得到常见的上电后 $FD。
export const CPU_POWER_ON_STATE = {
  accumulator: 0x00,
  indexX: 0x00,
  indexY: 0x00,
  programCounter: 0x0000,
  stackPointer: 0x00,
  status: CpuStatusFlag.Unused,
} as const;

export const CPU_RESET_SEQUENCE = {
  cycleCount: 7,
  stackReadCount: 3,
} as const;
