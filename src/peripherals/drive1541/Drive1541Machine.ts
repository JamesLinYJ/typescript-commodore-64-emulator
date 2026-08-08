// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 CPU 与外设时钟
//
//   文件:       Drive1541Machine.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Cpu6502 } from '../../core/cpu/Cpu6502';
import { CpuBusCycleInvariantError } from '../../core/cpu/CpuBusCycleInvariantError';
import { CpuIrqLine } from '../../core/cpu/CpuIrqLine';
import type { Drive1541Mechanism } from './Drive1541Mechanism';
import type { Drive1541BusCycleObserver, Drive1541Memory } from './Drive1541Memory';

const DRIVE_CPU_BOUNDARY_CLOCK_OFFSET = 1;

/** 在每个 6502 总线周期推进两个 VIA 与磁盘位流，避免按整条指令批量更新外设。 */
export class Drive1541Machine {
  private readonly irqLine = new CpuIrqLine();
  private cycleCount = 0;
  private observedBusCycles = 0;
  private readonly stopObservingByteReadyEdge: () => void;
  private readonly cpuBusCycleObserver: Drive1541BusCycleObserver = {
    completeCpuBusCycle: () => this.synchronizeInterruptInput(),
    startCpuBusCycle: () => {
      this.observedBusCycles += 1;
      this.advanceHardwareOneCycle();
    },
  };

  constructor(
    readonly cpu: Cpu6502,
    readonly memory: Drive1541Memory,
    readonly mechanism: Drive1541Mechanism,
  ) {
    this.stopObservingByteReadyEdge = mechanism.observeByteReadyEdge(() => {
      this.cpu.signalSetOverflow();
    });
  }

  get elapsedCycles(): number {
    return this.cycleCount;
  }

  /** 推进驱动器 CPU 的一个真实总线周期。 */
  clockCycle(checkBreakpoints = false): number {
    this.clockDirectCycle(checkBreakpoints);
    return 1;
  }

  /** 推进一批相邻总线周期。 */
  clockCycles(cycles: number, checkBreakpoints = false): number {
    if (!Number.isSafeInteger(cycles) || cycles < 0) {
      throw new RangeError('1541 CPU cycles must be a non-negative safe integer.');
    }
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      this.clockDirectCycle(checkBreakpoints);
    }
    return cycles;
  }

  executeInstruction(checkBreakpoints = false): number {
    const operationStartCycle = this.cycleCount;
    do this.clockDirectCycle(checkBreakpoints);
    while (!this.cpu.isAtInstructionBoundary && !this.cpu.isJammed);
    return this.cycleCount - operationStartCycle;
  }

  /** 通过驱动器自己的 CPU 总线执行七周期 /RESET，并同步推进 VIA 与磁盘位流。 */
  resetCpu(): number {
    const operationStartCycle = this.cycleCount;
    this.observedBusCycles = 0;
    this.irqLine.reset();
    const previousObserver = this.memory.setCpuBusCycleObserver(this.cpuBusCycleObserver);
    try {
      const cycles = this.cpu.reset();
      this.completeCpuOperation(cycles);
      return this.cycleCount - operationStartCycle;
    } finally {
      this.memory.setCpuBusCycleObserver(previousObserver);
    }
  }

  advanceHardware(cycles: number): void {
    if (!Number.isSafeInteger(cycles) || cycles < 0) {
      throw new RangeError('1541 hardware cycles must be a non-negative safe integer.');
    }
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      this.advanceHardwareOneCycle();
    }
  }

  resetTiming(): void {
    this.irqLine.reset();
    this.cycleCount = 0;
  }

  disconnect(): void {
    this.stopObservingByteReadyEdge();
  }

  private beginPendingInterruptSequence(): void {
    this.synchronizeInterruptInput();
    const boundaryClock = this.cycleCount + DRIVE_CPU_BOUNDARY_CLOCK_OFFSET;
    if (this.irqLine.isPending(boundaryClock)) {
      const assertedCycles = this.irqLine.assertedCycles(boundaryClock);
      if (this.cpu.canAcceptMaskableInterrupt(assertedCycles)) {
        this.irqLine.acknowledge();
        this.cpu.beginMaskableInterruptSequence();
      }
    }
    this.irqLine.completeCpuBoundaryPoll();
  }

  private clockDirectCycle(checkBreakpoints: boolean): void {
    if (this.cpu.isAtInstructionBoundary) this.beginPendingInterruptSequence();
    this.advanceHardwareOneCycle();
    try {
      this.cpu.clockCycle(checkBreakpoints);
    } finally {
      this.synchronizeInterruptInput();
    }
  }

  private advanceHardwareOneCycle(): void {
    this.cycleCount += 1;
    this.mechanism.tick(1);
    this.memory.iecVia.tick(1);
    this.memory.diskVia.tick(1);
    this.synchronizeInterruptInput();
  }

  private synchronizeInterruptInput(): void {
    this.irqLine.update(
      this.memory.iecVia.interruptPending || this.memory.diskVia.interruptPending,
      this.cycleCount,
    );
  }

  private completeCpuOperation(expectedCycles: number): void {
    if (this.observedBusCycles !== expectedCycles) {
      throw new CpuBusCycleInvariantError(expectedCycles, this.observedBusCycles);
    }
  }
}
