// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 浏览器动画帧时钟
//
//   文件:       BrowserFrameClock.ts
//
//   日期:       2026年08月10日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { RealtimeFrameClock } from './RealtimeEmulationLoop';

export const browserFrameClock: RealtimeFrameClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};
