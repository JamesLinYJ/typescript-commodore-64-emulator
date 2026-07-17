export interface CpuRegisters {
  readonly accumulator: number;
  readonly indexX: number;
  readonly indexY: number;
  readonly programCounter: number;
  readonly stackPointer: number;
  readonly status: number;
}
