// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6526 寄存器与接线常量
//
//   文件:       ciaRegisters.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const CIA_REGISTER_COUNT = 0x10;

export const CIA_REGISTER = {
  portA: 0x00,
  portB: 0x01,
  dataDirectionA: 0x02,
  dataDirectionB: 0x03,
  timerALow: 0x04,
  timerAHigh: 0x05,
  timerBLow: 0x06,
  timerBHigh: 0x07,
  timeOfDayTenths: 0x08,
  timeOfDaySeconds: 0x09,
  timeOfDayMinutes: 0x0a,
  timeOfDayHours: 0x0b,
  serialData: 0x0c,
  interruptControl: 0x0d,
  timerAControl: 0x0e,
  timerBControl: 0x0f,
} as const;

export const CIA_INTERRUPT_BIT = {
  timerA: 1 << 0,
  timerB: 1 << 1,
  alarm: 1 << 2,
  serial: 1 << 3,
  flag: 1 << 4,
  sourceMask: 0x1f,
  setOrPending: 1 << 7,
} as const;

export const CIA_TIMER_CONTROL_BIT = {
  start: 1 << 0,
  portBOutput: 1 << 1,
  toggleOutput: 1 << 2,
  oneShot: 1 << 3,
  forceLoad: 1 << 4,
  timerAInputMode: 1 << 5,
  serialOutputMode: 1 << 6,
  timeOfDay50Hz: 1 << 7,
  timerBInputModeMask: 0x60,
  alarmWrite: 1 << 7,
} as const;

export const CIA_TIMER_B_INPUT_MODE = {
  processorClock: 0,
  countPin: 1,
  timerAUnderflow: 2,
  timerAUnderflowWhileCountHigh: 3,
} as const;

export const CIA_TIMER_FULL_PERIOD = 0x1_0000;

export const CIA_TIME_OF_DAY = {
  registerCount: 4,
  tenthsPerSecond: 10,
  secondsPerMinute: 60,
  minutesPerHour: 60,
  hoursPerHalfDay: 12,
  inputPulsesAt50Hz: 5,
  inputPulsesAt60Hz: 6,
  afternoonBit: 1 << 7,
  hourMask: 0x1f,
} as const;

export const CIA_PORT_BIT = {
  timerAOutput: 1 << 6,
  timerBOutput: 1 << 7,
} as const;

export const CIA2_VIC_BANK = {
  selectMask: 0x03,
  addressShift: 14,
} as const;

export const CIA2_IEC_PORT_A_BIT = {
  attentionOutput: 1 << 3,
  clockOutput: 1 << 4,
  dataOutput: 1 << 5,
  clockInput: 1 << 6,
  dataInput: 1 << 7,
} as const;

export const MOS_6526_DEFAULT_TIMING = {
  processorClockHz: 985_248,
  timeOfDayInputHz: 50,
} as const;
