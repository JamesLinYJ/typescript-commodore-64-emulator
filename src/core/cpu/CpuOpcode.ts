export type AddressingMode = () => number;
export type InstructionHandler = (addressingMode: AddressingMode) => void;

export class CpuOpcode {
  constructor(
    readonly cycles: number,
    readonly length: number,
    readonly execute: InstructionHandler,
    readonly addressingMode: AddressingMode | null,
    readonly mnemonic: string,
  ) {}
}
