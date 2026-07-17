// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 芯片型号
//
//   文件:       SidModel.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const SID_MODEL = {
  mos6581: '6581',
  mos8580: '8580',
} as const;

export type SidModel = (typeof SID_MODEL)[keyof typeof SID_MODEL];
