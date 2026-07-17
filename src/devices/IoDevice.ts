// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 内存映射设备寄存器基类
//
//   文件:       IoDevice.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../shared/numbers';

export interface RegisterHandler {
  readonly read: (index: number) => number;
  readonly write: (index: number, value: number) => void;
}

export abstract class IoDevice {
  protected readonly registers: Uint8Array;
  private readonly handlers: RegisterHandler[];
  private readonly addressMask: number;

  protected constructor(
    readonly deviceName: string,
    registerCount: number,
    protected debug = false,
  ) {
    if (registerCount < 1 || (registerCount & (registerCount - 1)) !== 0) {
      throw new RangeError(`${deviceName} register count must be a power of two.`);
    }

    this.addressMask = registerCount - 1;
    this.registers = new Uint8Array(registerCount);
    this.handlers = Array.from({ length: registerCount }, (_, index) => ({
      read: () => this.readDefault(index),
      write: (_registerIndex, value) => this.writeDefault(index, value),
    }));
  }

  read(address: number): number {
    const index = address & this.addressMask;
    return byte(this.requireHandler(index).read(index));
  }

  write(address: number, value: number): void {
    const index = address & this.addressMask;
    this.requireHandler(index).write(index, byte(value));
  }

  setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  protected mapRegister(index: number, handler: Partial<RegisterHandler>): void {
    const defaultHandler = this.requireHandler(index);
    this.handlers[index] = {
      read: handler.read ?? defaultHandler.read,
      write: handler.write ?? defaultHandler.write,
    };
  }

  protected readDefault(index: number): number {
    const value = this.registers[index];
    if (value === undefined) this.throwRegisterRangeError(index);
    this.log(`read $${index.toString(16).padStart(2, '0')} = $${value.toString(16)}`);
    return value;
  }

  protected writeDefault(index: number, value: number): void {
    this.registers[index] = byte(value);
    this.log(`write $${index.toString(16).padStart(2, '0')} = $${byte(value).toString(16)}`);
  }

  protected log(message: string): void {
    if (this.debug) console.debug(`[${this.deviceName}] ${message}`);
  }

  private requireHandler(index: number): RegisterHandler {
    const handler = this.handlers[index];
    if (!handler) this.throwRegisterRangeError(index);
    return handler;
  }

  private throwRegisterRangeError(index: number): never {
    throw new RangeError(`${this.deviceName} register ${index} is out of range.`);
  }
}
