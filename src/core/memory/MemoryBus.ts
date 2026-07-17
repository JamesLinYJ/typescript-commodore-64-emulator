export interface MemoryBus {
  read(address: number): number;
  readWord(address: number): number;
  readStack(stackPointer: number): number;
  write(address: number, value: number): void;
  writeWord(address: number, value: number): void;
  writeStack(stackPointer: number, value: number): void;
}
