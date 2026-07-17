// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CPU NMI 边沿锁存
//
//   文件:       CpuNmiLine.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

/**
 * 模拟 NMOS 6502 对 NMI 有效边沿敏感的输入锁存器。
 *
 * 一旦捕获无效到有效的跳变，即使外设在 CPU 进入中断前释放物理线，该边沿仍保持待处理；
 * 持续有效电平不会重复产生新的 NMI。
 */
export class CpuNmiLine {
  private asserted = false;
  private edgeAtCycle: number | undefined;
  private edgePending = false;

  update(asserted: boolean, cycle: number): void {
    if (asserted && !this.asserted && !this.edgePending) {
      this.edgeAtCycle = cycle;
      this.edgePending = true;
    }
    this.asserted = asserted;
  }

  get isPending(): boolean {
    return this.edgePending;
  }

  elapsedCycles(cycle: number): number {
    return this.edgeAtCycle === undefined ? 0 : cycle - this.edgeAtCycle;
  }

  acknowledge(): void {
    this.edgeAtCycle = undefined;
    this.edgePending = false;
  }

  reset(): void {
    this.asserted = false;
    this.edgeAtCycle = undefined;
    this.edgePending = false;
  }
}
