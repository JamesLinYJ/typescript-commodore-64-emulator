// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 CPU 与外设时钟
//
//   文件:       Drive1541Machine.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { BreakpointError } from '../../core/cpu/BreakpointError';
import { Cpu6502 } from '../../core/cpu/Cpu6502';
import { CpuBusCycleInvariantError } from '../../core/cpu/CpuBusCycleInvariantError';
import { CpuIrqLine } from '../../core/cpu/CpuIrqLine';
import type { Drive1541Mechanism } from './Drive1541Mechanism';
import type { Drive1541Memory } from './Drive1541Memory';

const DRIVE_CPU_BOUNDARY_CLOCK_OFFSET = 1;

/** 在每个 6502 总线周期推进两个 VIA 与磁盘位流，避免按整条指令批量更新外设。 */
export class Drive1541Machine {
  private readonly irqLine = new CpuIrqLine();
  private cycleCount = 0;
  private observedBusCycles = 0;
  private readonly stopObservingByteReadyEdge: () => void;

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

  executeInstruction(checkBreakpoints = false): number {
    const operationStartCycle = this.cycleCount;
    this.observedBusCycles = 0;
    const previousObserver = this.memory.setCpuBusCycleObserver({
      completeCpuBusCycle: () => this.synchronizeInterruptInput(),
      startCpuBusCycle: () => {
        this.observedBusCycles += 1;
        this.advanceHardware(1);
      },
    });

    try {
      const interruptCycles = this.servicePendingInterrupt();
      if (interruptCycles > 0) {
        this.completeCpuOperation(interruptCycles);
        return this.cycleCount - operationStartCycle;
      }
      const cycles = this.cpu.executeInstruction(checkBreakpoints);
      this.completeCpuOperation(cycles);
      return this.cycleCount - operationStartCycle;
    } catch (error: unknown) {
      if (error instanceof BreakpointError) this.completeCpuOperation(error.cyclesConsumed);
      throw error;
    } finally {
      this.memory.setCpuBusCycleObserver(previousObserver);
    }
  }

  advanceHardware(cycles: number): void {
    if (!Number.isSafeInteger(cycles) || cycles < 0) {
      throw new RangeError('1541 hardware cycles must be a non-negative safe integer.');
    }
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      this.cycleCount += 1;
      this.mechanism.tick(1);
      this.memory.iecVia.tick(1);
      this.memory.diskVia.tick(1);
      this.synchronizeInterruptInput();
    }
  }

  resetTiming(): void {
    this.irqLine.reset();
    this.cycleCount = 0;
  }

  disconnect(): void {
    this.stopObservingByteReadyEdge();
  }

  private servicePendingInterrupt(): number {
    this.synchronizeInterruptInput();
    const boundaryClock = this.cycleCount + DRIVE_CPU_BOUNDARY_CLOCK_OFFSET;
    let interruptCycles = 0;
    if (this.irqLine.isPending(boundaryClock)) {
      const assertedCycles = this.irqLine.assertedCycles(boundaryClock);
      if (this.cpu.canAcceptMaskableInterrupt(assertedCycles)) {
        this.irqLine.acknowledge();
        interruptCycles = this.cpu.serviceMaskableInterrupt();
      }
    }
    this.irqLine.completeCpuBoundaryPoll();
    return interruptCycles;
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
