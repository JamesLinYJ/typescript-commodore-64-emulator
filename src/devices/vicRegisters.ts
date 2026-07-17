// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 寄存器与位常量
//
//   文件:       vicRegisters.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const VIC_REGISTER_COUNT = 0x40;
export const VIC_SPRITE_COUNT = 8;
export const VIC_BACKGROUND_COLOR_COUNT = 4;

export const VIC_REGISTER = {
  spriteXMostSignificantBits: 0x10,
  screenControl1: 0x11,
  rasterCounter: 0x12,
  lightPenX: 0x13,
  lightPenY: 0x14,
  spriteEnable: 0x15,
  screenControl2: 0x16,
  spriteExpandVertical: 0x17,
  memoryPointers: 0x18,
  interruptStatus: 0x19,
  interruptMask: 0x1a,
  spritePriority: 0x1b,
  spriteMulticolorEnable: 0x1c,
  spriteExpandHorizontal: 0x1d,
  spriteSpriteCollision: 0x1e,
  spriteForegroundCollision: 0x1f,
  borderColor: 0x20,
  backgroundColor0: 0x21,
  spriteMulticolor0: 0x25,
  spriteMulticolor1: 0x26,
  spriteColor0: 0x27,
  firstUnused: 0x2f,
} as const;

export const VIC_SCREEN_CONTROL_1_BIT = {
  rowSelect: 1 << 3,
  displayEnable: 1 << 4,
  bitmapMode: 1 << 5,
  extendedBackgroundMode: 1 << 6,
  rasterCounterHigh: 1 << 7,
} as const;

export const VIC_SCREEN_CONTROL_2_BIT = {
  columnSelect: 1 << 3,
  multicolorMode: 1 << 4,
} as const;

export const VIC_INTERRUPT_BIT = {
  raster: 1 << 0,
  spriteForegroundCollision: 1 << 1,
  spriteSpriteCollision: 1 << 2,
  lightPen: 1 << 3,
  any: 1 << 7,
} as const;

export const VIC_MASK = {
  color: 0x0f,
  interruptSources: 0x0f,
  interruptMaskReadHigh: 0xf0,
  interruptStatusReadHigh: 0x70,
  scroll: 0x07,
  raster: 0x01ff,
  rasterHigh: 0x0100,
  characterMemoryPointer: 0x0e,
  bitmapMemoryPointer: 0x08,
  screenMemoryPointer: 0xf0,
} as const;

export const VIC_REGISTER_READ_MASK = {
  colorHighBits: 0xf0,
  memoryPointersUnusedBit: 0x01,
  screenControl2UnusedBits: 0xc0,
  unusedRegister: 0xff,
} as const;

export const VIC_DISPLAY = {
  standardRowCount: 25,
  reducedRowCount: 24,
  standardColumnCount: 40,
  reducedColumnCount: 38,
  highestValidMode: 4,
} as const;
