// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - NMOS 6502 操作码逐周期元数据
//
//   文件:       CpuOpcodeMetadata.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const CPU_OPERATION = {
  ADC: 0,
  ALR: 1,
  ANC: 2,
  AND: 3,
  ARR: 4,
  ASL: 5,
  ASO: 6,
  AXA: 7,
  AXS_STORE: 8,
  BCC: 9,
  BCS: 10,
  BEQ: 11,
  BIT: 12,
  BMI: 13,
  BNE: 14,
  BPL: 15,
  BRK: 16,
  BVC: 17,
  BVS: 18,
  CLC: 19,
  CLD: 20,
  CLI: 21,
  CLV: 22,
  CMP: 23,
  CPX: 24,
  CPY: 25,
  DCM: 26,
  DEC: 27,
  DEX: 28,
  DEY: 29,
  EOR: 30,
  INC: 31,
  INS: 32,
  INX: 33,
  INY: 34,
  JAM: 35,
  JMP: 36,
  JSR: 37,
  LAS: 38,
  LAX: 39,
  LDA: 40,
  LDX: 41,
  LDY: 42,
  LSE: 43,
  LSR: 44,
  NOP: 45,
  OAL: 46,
  ORA: 47,
  PHA: 48,
  PHP: 49,
  PLA: 50,
  PLP: 51,
  RLA: 52,
  ROL: 53,
  ROR: 54,
  RRA: 55,
  RTI: 56,
  RTS: 57,
  SAX_SUBTRACT: 58,
  SAY: 59,
  SBC: 60,
  SEC: 61,
  SED: 62,
  SEI: 63,
  STA: 64,
  STX: 65,
  STY: 66,
  TAS: 67,
  TAX: 68,
  TAY: 69,
  TSX: 70,
  TXA: 71,
  TXS: 72,
  TYA: 73,
  XAA: 74,
  XAS: 75,
} as const;

export const CPU_CYCLE_TEMPLATE = {
  ACCUMULATOR: 0,
  BRANCH: 1,
  BRK: 2,
  IMPLIED: 3,
  JAM: 4,
  JMP_ABS: 5,
  JMP_IND: 6,
  JSR: 7,
  READ_ABS: 8,
  READ_ABSX: 9,
  READ_ABSY: 10,
  READ_IMM: 11,
  READ_INDX: 12,
  READ_INDY: 13,
  READ_ZP: 14,
  READ_ZPX: 15,
  READ_ZPY: 16,
  RMW_ABS: 17,
  RMW_ABSX: 18,
  RMW_ABSY: 19,
  RMW_INDX: 20,
  RMW_INDY: 21,
  RMW_ZP: 22,
  RMW_ZPX: 23,
  RTI: 24,
  RTS: 25,
  STACK_PULL: 26,
  STACK_PUSH: 27,
  WRITE_ABS: 28,
  WRITE_ABSX: 29,
  WRITE_ABSY: 30,
  WRITE_INDX: 31,
  WRITE_INDY: 32,
  WRITE_ZP: 33,
  WRITE_ZPX: 34,
  WRITE_ZPY: 35,
} as const;

export const CPU_ADDRESS_MODE = {
  ABS: 0,
  ABSX: 1,
  ABSY: 2,
  ACC: 3,
  IMM: 4,
  IMP: 5,
  IND: 6,
  INDX: 7,
  INDY: 8,
  REL: 9,
  ZP: 10,
  ZPX: 11,
  ZPY: 12,
} as const;

export const CPU_MEMORY_ACCESS = {
  NONE: 0,
  READ: 1,
  RMW: 2,
  WRITE: 3,
} as const;

export const CPU_PAGE_RULE = {
  BRANCH_TAKEN_THEN_CROSS: 0,
  INDEXED_DUMMY_ALWAYS: 1,
  INDIRECT_POINTER_WRAP: 2,
  NONE: 3,
  READ_CROSS_ADDS_CYCLE: 4,
  UNSTABLE_STORE_ADDRESS_ON_CROSS: 5,
} as const;

export const CPU_OPCODE_FLAG = {
  ARR_DECIMAL_RULES: 1 << 0,
  COMPOSITE_RMW: 1 << 1,
  DUPLICATE_SBC_ENCODING: 1 << 2,
  JAM: 1 << 3,
  UNDOCUMENTED: 1 << 4,
  UNSTABLE_DATA_MASK: 1 << 5,
  UNSTABLE_INDEXED_STORE: 1 << 6,
} as const;

// plan 位布局：template[5:0]、mode[9:6]、access[11:10]、page-rule[14:12]。
export const CPU_OPCODE_PLAN_TEMPLATE_MASK = 0x003f;
export const CPU_OPCODE_PLAN_MODE_SHIFT = 6;
export const CPU_OPCODE_PLAN_MODE_MASK = 0x000f;
export const CPU_OPCODE_PLAN_ACCESS_SHIFT = 10;
export const CPU_OPCODE_PLAN_ACCESS_MASK = 0x0003;
export const CPU_OPCODE_PLAN_PAGE_RULE_SHIFT = 12;
export const CPU_OPCODE_PLAN_PAGE_RULE_MASK = 0x0007;

export const CPU_OPCODE_OPERATION = new Uint8Array([
  16, 47, 35, 6, 45, 47, 5, 6, 49, 47, 5, 2, 45, 47, 5, 6, 15, 47, 35, 6, 45, 47, 5, 6, 19, 47, 45,
  6, 45, 47, 5, 6, 37, 3, 35, 52, 12, 3, 53, 52, 51, 3, 53, 2, 12, 3, 53, 52, 13, 3, 35, 52, 45, 3,
  53, 52, 61, 3, 45, 52, 45, 3, 53, 52, 56, 30, 35, 43, 45, 30, 44, 43, 48, 30, 44, 1, 36, 30, 44,
  43, 17, 30, 35, 43, 45, 30, 44, 43, 21, 30, 45, 43, 45, 30, 44, 43, 57, 0, 35, 55, 45, 0, 54, 55,
  50, 0, 54, 4, 36, 0, 54, 55, 18, 0, 35, 55, 45, 0, 54, 55, 63, 0, 45, 55, 45, 0, 54, 55, 45, 64,
  45, 8, 66, 64, 65, 8, 29, 45, 71, 74, 66, 64, 65, 8, 9, 64, 35, 7, 66, 64, 65, 8, 73, 64, 72, 67,
  59, 64, 75, 7, 42, 40, 41, 39, 42, 40, 41, 39, 69, 40, 68, 46, 42, 40, 41, 39, 10, 40, 35, 39, 42,
  40, 41, 39, 22, 40, 70, 38, 42, 40, 41, 39, 25, 23, 45, 26, 25, 23, 27, 26, 34, 23, 28, 58, 25,
  23, 27, 26, 14, 23, 35, 26, 45, 23, 27, 26, 20, 23, 45, 26, 45, 23, 27, 26, 24, 60, 45, 32, 24,
  60, 31, 32, 33, 60, 45, 60, 24, 60, 31, 32, 11, 60, 35, 32, 45, 60, 31, 32, 62, 60, 45, 32, 45,
  60, 31, 32,
]);

export const CPU_OPCODE_PLAN = new Uint16Array([
  0x3142, 0x35cc, 0x3144, 0x39d4, 0x368e, 0x368e, 0x3a96, 0x3a96, 0x315b, 0x350b, 0x30c0, 0x350b,
  0x3408, 0x3408, 0x3811, 0x3811, 0x0241, 0x460d, 0x3144, 0x1a15, 0x36cf, 0x36cf, 0x3ad7, 0x3ad7,
  0x3143, 0x448a, 0x3143, 0x1893, 0x4449, 0x4449, 0x1852, 0x1852, 0x3007, 0x35cc, 0x3144, 0x39d4,
  0x368e, 0x368e, 0x3a96, 0x3a96, 0x315a, 0x350b, 0x30c0, 0x350b, 0x3408, 0x3408, 0x3811, 0x3811,
  0x0241, 0x460d, 0x3144, 0x1a15, 0x36cf, 0x36cf, 0x3ad7, 0x3ad7, 0x3143, 0x448a, 0x3143, 0x1893,
  0x4449, 0x4449, 0x1852, 0x1852, 0x3158, 0x35cc, 0x3144, 0x39d4, 0x368e, 0x368e, 0x3a96, 0x3a96,
  0x315b, 0x350b, 0x30c0, 0x350b, 0x3005, 0x3408, 0x3811, 0x3811, 0x0241, 0x460d, 0x3144, 0x1a15,
  0x36cf, 0x36cf, 0x3ad7, 0x3ad7, 0x3143, 0x448a, 0x3143, 0x1893, 0x4449, 0x4449, 0x1852, 0x1852,
  0x3159, 0x35cc, 0x3144, 0x39d4, 0x368e, 0x368e, 0x3a96, 0x3a96, 0x315a, 0x350b, 0x30c0, 0x350b,
  0x2186, 0x3408, 0x3811, 0x3811, 0x0241, 0x460d, 0x3144, 0x1a15, 0x36cf, 0x36cf, 0x3ad7, 0x3ad7,
  0x3143, 0x448a, 0x3143, 0x1893, 0x4449, 0x4449, 0x1852, 0x1852, 0x350b, 0x3ddf, 0x350b, 0x3ddf,
  0x3ea1, 0x3ea1, 0x3ea1, 0x3ea1, 0x3143, 0x350b, 0x3143, 0x350b, 0x3c1c, 0x3c1c, 0x3c1c, 0x3c1c,
  0x0241, 0x1e20, 0x3144, 0x5e20, 0x3ee2, 0x3ee2, 0x3f23, 0x3f23, 0x3143, 0x1c9e, 0x3143, 0x5c9e,
  0x5c5d, 0x1c5d, 0x5c9e, 0x5c9e, 0x350b, 0x35cc, 0x350b, 0x35cc, 0x368e, 0x368e, 0x368e, 0x368e,
  0x3143, 0x350b, 0x3143, 0x350b, 0x3408, 0x3408, 0x3408, 0x3408, 0x0241, 0x460d, 0x3144, 0x460d,
  0x36cf, 0x36cf, 0x3710, 0x3710, 0x3143, 0x448a, 0x3143, 0x448a, 0x4449, 0x4449, 0x448a, 0x448a,
  0x350b, 0x35cc, 0x350b, 0x39d4, 0x368e, 0x368e, 0x3a96, 0x3a96, 0x3143, 0x350b, 0x3143, 0x350b,
  0x3408, 0x3408, 0x3811, 0x3811, 0x0241, 0x460d, 0x3144, 0x1a15, 0x36cf, 0x36cf, 0x3ad7, 0x3ad7,
  0x3143, 0x448a, 0x3143, 0x1893, 0x4449, 0x4449, 0x1852, 0x1852, 0x350b, 0x35cc, 0x350b, 0x39d4,
  0x368e, 0x368e, 0x3a96, 0x3a96, 0x3143, 0x350b, 0x3143, 0x350b, 0x3408, 0x3408, 0x3811, 0x3811,
  0x0241, 0x460d, 0x3144, 0x1a15, 0x36cf, 0x36cf, 0x3ad7, 0x3ad7, 0x3143, 0x448a, 0x3143, 0x1893,
  0x4449, 0x4449, 0x1852, 0x1852,
]);

export const CPU_OPCODE_FLAGS = new Uint8Array([
  0, 0, 24, 18, 16, 0, 0, 18, 0, 0, 0, 16, 16, 0, 0, 18, 0, 0, 24, 18, 16, 0, 0, 18, 0, 0, 16, 18,
  16, 0, 0, 18, 0, 0, 24, 18, 0, 0, 0, 18, 0, 0, 0, 16, 0, 0, 0, 18, 0, 0, 24, 18, 16, 0, 0, 18, 0,
  0, 16, 18, 16, 0, 0, 18, 0, 0, 24, 18, 16, 0, 0, 18, 0, 0, 0, 16, 0, 0, 0, 18, 0, 0, 24, 18, 16,
  0, 0, 18, 0, 0, 16, 18, 16, 0, 0, 18, 0, 0, 24, 18, 16, 0, 0, 18, 0, 0, 0, 17, 0, 0, 0, 18, 0, 0,
  24, 18, 16, 0, 0, 18, 0, 0, 16, 18, 16, 0, 0, 18, 16, 0, 16, 16, 0, 0, 0, 16, 0, 16, 0, 48, 0, 0,
  0, 16, 0, 0, 24, 80, 0, 0, 0, 16, 0, 0, 0, 80, 80, 0, 80, 80, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0,
  48, 0, 0, 0, 16, 0, 0, 24, 16, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 16, 18, 0, 0, 0, 18,
  0, 0, 0, 16, 0, 0, 0, 18, 0, 0, 24, 18, 16, 0, 0, 18, 0, 0, 16, 18, 16, 0, 0, 18, 0, 0, 16, 18, 0,
  0, 0, 18, 0, 0, 0, 20, 0, 0, 0, 18, 0, 0, 24, 18, 16, 0, 0, 18, 0, 0, 16, 18, 16, 0, 0, 18,
]);

export const CPU_CYCLE_TEMPLATE_BASE_CYCLES = new Uint8Array([
  2, 2, 7, 2, 2, 3, 5, 6, 4, 4, 4, 2, 6, 5, 3, 4, 4, 6, 7, 7, 8, 8, 5, 6, 6, 6, 4, 3, 4, 5, 5, 6, 6,
  3, 4, 4,
]);

export const CPU_ADDRESS_MODE_LENGTH = new Uint8Array([3, 3, 3, 1, 2, 1, 3, 2, 2, 2, 2, 2, 2]);
