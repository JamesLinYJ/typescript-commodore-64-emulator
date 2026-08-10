// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 整机时钟与总线仲裁
//
//   文件:       C64Machine.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { BreakpointError } from './cpu/BreakpointError';
import { CpuBusArbitrationInvariantError } from './CpuBusArbitrationInvariantError';
import { CpuBusCycleInvariantError } from './cpu/CpuBusCycleInvariantError';
import type { Cpu6502 } from './cpu/Cpu6502';
import { CpuIrqLine } from './cpu/CpuIrqLine';
import { CpuNmiLine } from './cpu/CpuNmiLine';
import type { C64Memory, CpuBusAccessKind, CpuBusCycleObserver } from './memory/C64Memory';

const CPU_BOUNDARY_CLOCK_OFFSET = 1;

export interface C64ClockedPeripheral {
  advanceHostCycle(): void;
  advanceHostCycles(cycles: number): void;
  resetClock(): void;
}

export class C64Machine {
  private readonly irqLine = new CpuIrqLine();
  private readonly nmiLine = new CpuNmiLine();
  private cycleCount = 0;
  private observedBusCycles = 0;
  private lastCpuReadWasHeld = false;
  // CPU 每秒会执行数十万条指令；复用观察器可以避免在每条指令边界创建对象和两个闭包。
  private readonly cpuBusCycleObserver: CpuBusCycleObserver = {
    completeCpuBusCycle: () => this.synchronizeInterruptInputs(),
    startCpuBusCycle: (kind, address) => {
      this.lastCpuReadWasHeld = this.advanceCpuBusCycle(kind, address);
      this.observedBusCycles += 1;
      this.assertCpuBusOwnership(kind, address);
    },
  };
  private readonly cpuNmiTakeoverProbe = () => this.acknowledgeNmiTakeover();
  private readonly cpuReadWasHeldProbe = () => this.lastCpuReadWasHeld;

  constructor(
    readonly cpu: Cpu6502,
    readonly memory: C64Memory,
    private readonly clockedPeripherals: readonly C64ClockedPeripheral[] = [],
  ) {
    this.cpu.setNmiTakeoverProbe(this.cpuNmiTakeoverProbe);
    this.cpu.setReadWasHeldProbe(this.cpuReadWasHeldProbe);
  }

  get elapsedCycles(): number {
    return this.cycleCount;
  }

  executeInstruction(checkBreakpoints = false): number {
    const operationStartCycle = this.cycleCount;
    this.observedBusCycles = 0;
    this.lastCpuReadWasHeld = false;
    const previousObserver = this.memory.setCpuBusCycleObserver(this.cpuBusCycleObserver);

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

  /** 让 CPU 的七周期 /RESET 序列通过正常总线仲裁推进整机硬件。 */
  resetCpu(): number {
    const operationStartCycle = this.cycleCount;
    this.observedBusCycles = 0;
    this.lastCpuReadWasHeld = false;
    this.irqLine.reset();
    this.nmiLine.reset();
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
    const elapsed = Math.max(0, Math.trunc(cycles));
    if (elapsed === 0) return;

    for (let cycle = 0; cycle < elapsed; cycle += 1) {
      this.advanceHardwareCycle();
    }
  }

  resetTiming(): void {
    this.irqLine.reset();
    this.nmiLine.reset();
    this.cycleCount = 0;
    this.lastCpuReadWasHeld = false;
    for (const peripheral of this.clockedPeripherals) peripheral.resetClock();
  }

  private servicePendingInterrupt(): number {
    this.synchronizeInterruptInputs();
    const boundaryClock = this.cycleCount + CPU_BOUNDARY_CLOCK_OFFSET;
    if (
      this.nmiLine.isPending &&
      this.cpu.canAcceptNonMaskableInterrupt(this.nmiLine.elapsedCycles(boundaryClock))
    ) {
      this.nmiLine.acknowledge();
      this.irqLine.completeCpuBoundaryPoll();
      return this.cpu.nmi();
    }

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

  private synchronizeInterruptInputs(): void {
    // CIA2、RESTORE 单稳态电路与扩展口共同驱动 6510 的低有效 NMI 引脚。
    const nmiAsserted =
      this.memory.cia2.interruptPending ||
      this.memory.restoreKey.nmiAsserted ||
      this.memory.cartridge.nmiLineLow;
    this.nmiLine.update(nmiAsserted, this.cycleCount);

    const asserted =
      this.memory.cia1.interruptPending ||
      this.memory.vic.interruptPending ||
      this.memory.cartridge.irqLineLow;
    this.irqLine.update(asserted, this.cycleCount);
  }

  private acknowledgeNmiTakeover(): boolean {
    this.synchronizeInterruptInputs();
    const vectorSelectionClock = this.cycleCount + CPU_BOUNDARY_CLOCK_OFFSET;
    if (
      !this.nmiLine.isPending ||
      !this.cpu.canTakeOverInterruptSequenceWithNmi(
        this.nmiLine.elapsedCycles(vectorSelectionClock),
      )
    ) {
      return false;
    }
    this.nmiLine.acknowledge();
    return true;
  }

  private completeCpuOperation(totalCycles: number): void {
    if (this.observedBusCycles !== totalCycles) {
      throw new CpuBusCycleInvariantError(totalCycles, this.observedBusCycles);
    }
  }

  private advanceCpuBusCycle(kind: CpuBusAccessKind, address: number): boolean {
    // BA 在当前 φ2 周期决定 6510 的读访问是否完成，所以必须先推进到被尝试的周期再采样。
    // 读周期会保持地址并重复到 BA 释放；写周期不响应 RDY，可在 AEC 拉低前的三周期预告窗内完成。
    if (kind === 'write') {
      this.advanceHardwareCycle();
      return false;
    }

    this.advanceHardwareCycle(address);
    if (!this.memory.vic.baLow) return false;
    do this.advanceHardwareCycle(address);
    while (this.memory.vic.baLow);
    return true;
  }

  private advanceHardwareCycle(cpuReadAddress?: number): void {
    this.cycleCount += 1;
    this.memory.processorPort.clockCycle();
    this.memory.restoreKey.clockCycle();
    this.memory.datasette.clockCycle();
    this.memory.cartridge.tick(1);
    this.memory.cia1.clockCycle();
    this.memory.cia2.clockCycle();
    // CPU 读地址在 φ2 内保持不变；被动 RAM/ROM 在 VIC 执行 C-access 前驱动
    // 数据总线。这个相位不会提前触发 CIA/VIC/SID 的读副作用。
    if (cpuReadAddress !== undefined) this.memory.driveCpuReadDataBus(cpuReadAddress);
    this.memory.vic.clockCycle(this.memory);
    this.memory.sid.clockCycle();
    for (const peripheral of this.clockedPeripherals) peripheral.advanceHostCycle();
    this.synchronizeInterruptInputs();
  }

  private assertCpuBusOwnership(kind: CpuBusAccessKind, address: number): void {
    if (!this.memory.vic.aecLow) return;
    throw new CpuBusArbitrationInvariantError({
      access: kind,
      address,
      rasterCycle: this.memory.vic.currentRasterCycle,
      rasterLine: this.memory.vic.currentRasterLine,
    });
  }
}
