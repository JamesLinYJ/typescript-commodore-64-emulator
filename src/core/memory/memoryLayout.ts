// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 内存布局常量
//
//   文件:       memoryLayout.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const C64_MEMORY_LAYOUT = {
  addressSpace: {
    size: 0x1_0000,
    pageSize: 0x0100,
    pageCount: 0x0100,
  },
  processorPort: {
    directionRegister: 0x0000,
    bankingRegister: 0x0001,
    powerOnDirection: 0x00,
    powerOnData: 0x00,
    pullUpMask: 0x17,
    floatingPinMask: 0xc0,
    floatingPinFallOffCycles: 350_000,
  },
  stack: {
    start: 0x0100,
  },
  basicRom: {
    start: 0xa000,
    size: 0x2000,
    firstPage: 0xa0,
    lastPage: 0xbf,
  },
  characterRom: {
    start: 0xd000,
    size: 0x1000,
    firstPage: 0xd0,
    lastPage: 0xdf,
  },
  kernalRom: {
    start: 0xe000,
    size: 0x2000,
    firstPage: 0xe0,
    lastPage: 0xff,
  },
  vic: {
    firstPage: 0xd0,
    lastPage: 0xd3,
  },
  sid: {
    firstPage: 0xd4,
    lastPage: 0xd7,
  },
  colorRam: {
    start: 0xd800,
    size: 0x0400,
    firstPage: 0xd8,
    lastPage: 0xdb,
  },
  cia1: {
    firstPage: 0xdc,
    lastPage: 0xdc,
  },
  cia2: {
    firstPage: 0xdd,
    lastPage: 0xdd,
  },
  cartridgeIo1: {
    firstPage: 0xde,
    lastPage: 0xde,
  },
  cartridgeIo2: {
    firstPage: 0xdf,
    lastPage: 0xdf,
  },
} as const;

export const PROCESSOR_PORT_BIT = {
  basicRom: 1 << 0,
  kernalRom: 1 << 1,
  characterIoSelect: 1 << 2,
  cassetteWrite: 1 << 3,
  cassetteSense: 1 << 4,
  cassetteMotor: 1 << 5,
} as const;
