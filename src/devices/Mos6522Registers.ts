// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6522 寄存器常量
//
//   文件:       Mos6522Registers.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const MOS_6522_REGISTER = {
  portB: 0x00,
  portA: 0x01,
  dataDirectionB: 0x02,
  dataDirectionA: 0x03,
  timer1CounterLow: 0x04,
  timer1CounterHigh: 0x05,
  timer1LatchLow: 0x06,
  timer1LatchHigh: 0x07,
  timer2CounterLow: 0x08,
  timer2CounterHigh: 0x09,
  shiftRegister: 0x0a,
  auxiliaryControl: 0x0b,
  peripheralControl: 0x0c,
  interruptFlags: 0x0d,
  interruptEnable: 0x0e,
  portAWithoutHandshake: 0x0f,
} as const;

export const MOS_6522_REGISTER_COUNT = 0x10;

export const MOS_6522_INTERRUPT_BIT = {
  ca2: 1 << 0,
  ca1: 1 << 1,
  shiftRegister: 1 << 2,
  cb2: 1 << 3,
  cb1: 1 << 4,
  timer2: 1 << 5,
  timer1: 1 << 6,
  any: 1 << 7,
  sourceMask: 0x7f,
} as const;

export const MOS_6522_ACR_BIT = {
  portAInputLatch: 1 << 0,
  portBInputLatch: 1 << 1,
  shiftModeMask: 0x1c,
  timer2CountPortB6: 1 << 5,
  timer1FreeRunning: 1 << 6,
  timer1PortB7Output: 1 << 7,
} as const;

export const MOS_6522_SHIFT_MODE = {
  disabled: 0,
  inputTimer2: 1,
  inputProcessorClock: 2,
  inputExternalClock: 3,
  outputFreeRunningTimer2: 4,
  outputTimer2: 5,
  outputProcessorClock: 6,
  outputExternalClock: 7,
} as const;

export type Mos6522ShiftMode = (typeof MOS_6522_SHIFT_MODE)[keyof typeof MOS_6522_SHIFT_MODE];

export const MOS_6522_PCR_CONTROL_MODE = {
  inputNegativeEdge: 0,
  inputNegativeEdgeIndependent: 1,
  inputPositiveEdge: 2,
  inputPositiveEdgeIndependent: 3,
  handshakeOutput: 4,
  pulseOutput: 5,
  lowOutput: 6,
  highOutput: 7,
} as const;

export const MOS_6522_CONTROL_LINE = {
  ca1: 'ca1',
  ca2: 'ca2',
  cb1: 'cb1',
  cb2: 'cb2',
} as const;

export type Mos6522ControlLine = (typeof MOS_6522_CONTROL_LINE)[keyof typeof MOS_6522_CONTROL_LINE];
