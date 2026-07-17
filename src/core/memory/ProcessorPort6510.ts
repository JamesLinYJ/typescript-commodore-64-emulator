// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6510 处理器端口
//
//   文件:       ProcessorPort6510.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';
import { C64_MEMORY_LAYOUT } from './memoryLayout';

export interface ProcessorPort6510Options {
  readonly floatingPinFallOffCycles?: number;
}

export interface ProcessorPortOutputState {
  readonly direction: number;
  readonly outputLatch: number;
  readonly outputPins: number;
}

export type ProcessorPortOutputObserver = (state: ProcessorPortOutputState) => void;

export class ProcessorPort6510 {
  private direction = 0;
  private output = 0;
  private inputPins: number = C64_MEMORY_LAYOUT.processorPort.pullUpMask;
  private floatingPinCharge = 0;
  private bit6FallOffRemaining = 0;
  private bit7FallOffRemaining = 0;
  private readonly floatingPinFallOffCycles: number;
  private readonly outputObservers = new Set<ProcessorPortOutputObserver>();

  constructor(options: ProcessorPort6510Options = {}) {
    this.floatingPinFallOffCycles = Math.max(
      1,
      Math.trunc(
        options.floatingPinFallOffCycles ??
          C64_MEMORY_LAYOUT.processorPort.floatingPinFallOffCycles,
      ),
    );
    this.reset();
  }

  get directionRegister(): number {
    return this.direction;
  }

  get dataRegister(): number {
    const inputMask = byte(~this.direction);
    const connectedInputs = this.inputPins & inputMask;
    const floatingInputs =
      this.floatingPinCharge & inputMask & C64_MEMORY_LAYOUT.processorPort.floatingPinMask;
    return byte((this.output & this.direction) | connectedInputs | floatingInputs);
  }

  get outputLatch(): number {
    return this.output;
  }

  get outputPins(): number {
    return byte((this.output & this.direction) | ~this.direction);
  }

  get bankingConfiguration(): number {
    return this.dataRegister & 0x07;
  }

  reset(): void {
    const previousPins = this.outputPins;
    this.direction = C64_MEMORY_LAYOUT.processorPort.powerOnDirection;
    this.output = C64_MEMORY_LAYOUT.processorPort.powerOnData;
    this.inputPins = C64_MEMORY_LAYOUT.processorPort.pullUpMask;
    this.floatingPinCharge = 0;
    this.bit6FallOffRemaining = 0;
    this.bit7FallOffRemaining = 0;
    if (this.outputPins !== previousPins) this.notifyOutputObservers();
  }

  writeDirection(value: number): void {
    const previousPins = this.outputPins;
    const nextDirection = byte(value);
    const switchedToInput =
      this.direction & ~nextDirection & C64_MEMORY_LAYOUT.processorPort.floatingPinMask;
    this.chargeFloatingPins(switchedToInput, this.output);
    this.direction = nextDirection;
    if (this.outputPins !== previousPins) this.notifyOutputObservers();
  }

  writeData(value: number): void {
    const previousPins = this.outputPins;
    const nextOutput = byte(value);
    const drivenFloatingPins = this.direction & C64_MEMORY_LAYOUT.processorPort.floatingPinMask;
    this.chargeFloatingPins(drivenFloatingPins, nextOutput);
    this.output = nextOutput;
    if (this.outputPins !== previousPins) this.notifyOutputObservers();
  }

  observeOutputPins(observer: ProcessorPortOutputObserver): () => void {
    this.outputObservers.add(observer);
    return () => this.outputObservers.delete(observer);
  }

  setInputPins(mask: number, value: number): void {
    const normalizedMask = byte(mask) & ~C64_MEMORY_LAYOUT.processorPort.floatingPinMask;
    this.inputPins = byte((this.inputPins & ~normalizedMask) | (byte(value) & normalizedMask));
  }

  tick(cycles: number): void {
    const elapsed = Math.max(0, Math.trunc(cycles));
    if (elapsed === 0) return;

    if (this.bit6FallOffRemaining > 0) {
      this.bit6FallOffRemaining = Math.max(0, this.bit6FallOffRemaining - elapsed);
      if (this.bit6FallOffRemaining === 0) this.floatingPinCharge &= ~0x40;
    }
    if (this.bit7FallOffRemaining > 0) {
      this.bit7FallOffRemaining = Math.max(0, this.bit7FallOffRemaining - elapsed);
      if (this.bit7FallOffRemaining === 0) this.floatingPinCharge &= ~0x80;
    }
  }

  private chargeFloatingPins(mask: number, value: number): void {
    if ((mask & 0x40) !== 0) {
      this.floatingPinCharge = (this.floatingPinCharge & ~0x40) | (value & 0x40);
      this.bit6FallOffRemaining = (value & 0x40) !== 0 ? this.floatingPinFallOffCycles : 0;
    }
    if ((mask & 0x80) !== 0) {
      this.floatingPinCharge = (this.floatingPinCharge & ~0x80) | (value & 0x80);
      this.bit7FallOffRemaining = (value & 0x80) !== 0 ? this.floatingPinFallOffCycles : 0;
    }
  }

  private notifyOutputObservers(): void {
    const state = {
      direction: this.direction,
      outputLatch: this.output,
      outputPins: this.outputPins,
    } as const;
    for (const observer of [...this.outputObservers]) observer(state);
  }
}
