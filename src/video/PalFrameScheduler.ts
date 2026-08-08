import type { Cpu6502 } from '../core/cpu/Cpu6502';
import { C64Machine, type C64ClockedPeripheral } from '../core/C64Machine';
import type { C64Memory } from '../core/memory/C64Memory';

export type RasterLineCallback = (rasterLine: number) => void;

export class PalFrameScheduler {
  readonly machine: C64Machine;

  constructor(
    cpu: Cpu6502,
    private readonly memory: C64Memory,
    clockedPeripherals: readonly C64ClockedPeripheral[] = [],
  ) {
    this.machine = new C64Machine(cpu, memory, clockedPeripherals);
  }

  executeInstruction(checkBreakpoints = false): number {
    return this.machine.executeInstruction(checkBreakpoints);
  }

  runFrame(onRasterLine?: RasterLineCallback, checkBreakpoints = false): void {
    let frameCompleted = false;
    const stopObserving = this.memory.vic.observeRasterLines((event) => {
      onRasterLine?.(event.rasterLine);
      if (event.frameCompleted) frameCompleted = true;
    });
    try {
      while (!frameCompleted) {
        this.executeInstruction(checkBreakpoints);
      }
    } finally {
      stopObserving();
    }
  }

  resetTiming(): void {
    this.machine.resetTiming();
  }

  resetCpu(): number {
    return this.machine.resetCpu();
  }
}
