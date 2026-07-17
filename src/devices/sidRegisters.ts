// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 寄存器与速率常量
//
//   文件:       sidRegisters.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const SID_REGISTER_COUNT = 0x20;
export const SID_VOICE_COUNT = 3;
export const SID_VOICE_REGISTER_COUNT = 7;

export const SID_VOICE_REGISTER = {
  frequencyLow: 0,
  frequencyHigh: 1,
  pulseWidthLow: 2,
  pulseWidthHigh: 3,
  control: 4,
  attackDecay: 5,
  sustainRelease: 6,
} as const;

export const SID_REGISTER = {
  filterCutoffLow: 0x15,
  filterCutoffHigh: 0x16,
  filterResonanceRouting: 0x17,
  filterModeVolume: 0x18,
  paddleX: 0x19,
  paddleY: 0x1a,
  oscillator3: 0x1b,
  envelope3: 0x1c,
} as const;

export const SID_CONTROL_BIT = {
  gate: 1 << 0,
  synchronize: 1 << 1,
  ringModulation: 1 << 2,
  test: 1 << 3,
  triangle: 1 << 4,
  sawtooth: 1 << 5,
  pulse: 1 << 6,
  noise: 1 << 7,
} as const;

export const SID_FILTER_BIT = {
  voice1: 1 << 0,
  voice2: 1 << 1,
  voice3: 1 << 2,
  externalInput: 1 << 3,
  lowPass: 1 << 4,
  bandPass: 1 << 5,
  highPass: 1 << 6,
  muteVoice3: 1 << 7,
} as const;

export const SID_MASK = {
  accumulator: 0x00ff_ffff,
  phaseWaveform: 0x0fff,
  pulseWidth: 0x0fff,
  filterCutoff: 0x07ff,
  volume: 0x0f,
  resonance: 0x0f,
} as const;

export const SID_TIMING = {
  processorClockHz: 985_248,
  sampleRateHz: 44_100,
  sampleBufferCapacity: 16_384,
  busLatchDecayCycles: {
    '6581': 0x1d00,
    '8580': 0xa_2000,
  },
} as const;

// 这些是 15 位速率计数器的比较值；比较后的下一周期才清零，所以实际间隔还包含一个周期。
export const SID_ENVELOPE_RATE_COMPARE_VALUES = [
  8, 31, 62, 94, 148, 219, 266, 312, 391, 976, 1_953, 3_125, 3_906, 11_719, 19_531, 31_250,
] as const;
