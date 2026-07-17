// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CPU IRQ 输入线锁存
//
//   文件:       CpuIrqLine.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

const IRQ_DEASSERTION_HOLD_CYCLES = 3;

/**
 * 把 C64 上汇合的低有效 IRQ 源同步到 6510 输入锁存器。
 *
 * 物理线恢复高电平后，已出现的低脉冲仍保留到三周期识别窗口结束。这是 NMOS CPU
 * 输入级的行为，不能错误归入 VIC-II 或 CIA 的中断寄存器。
 */
export class CpuIrqLine {
  private asserted = false;
  private assertedAtCycle: number | undefined;
  private pendingUntilCycle: number | undefined;

  update(asserted: boolean, cycle: number): void {
    if (asserted && !this.asserted) {
      this.asserted = true;
      this.assertedAtCycle = cycle;
      this.pendingUntilCycle = undefined;
      return;
    }

    if (!asserted && this.asserted) {
      this.asserted = false;
      this.pendingUntilCycle = cycle + IRQ_DEASSERTION_HOLD_CYCLES;
    }

    if (!this.asserted && this.pendingUntilCycle !== undefined && cycle >= this.pendingUntilCycle) {
      this.assertedAtCycle = undefined;
      this.pendingUntilCycle = undefined;
    }
  }

  isPending(cycle: number): boolean {
    return (
      this.asserted || (this.pendingUntilCycle !== undefined && cycle < this.pendingUntilCycle)
    );
  }

  assertedCycles(cycle: number): number {
    return this.assertedAtCycle === undefined ? 0 : cycle - this.assertedAtCycle;
  }

  /**
   * 完成一次 CPU 指令边界轮询。
   *
   * 已恢复高电平的脉冲可以参与本次轮询；若 CPU 没有接受，则不能泄漏到更晚的指令边界。
   */
  completeCpuBoundaryPoll(): void {
    if (!this.asserted) {
      this.assertedAtCycle = undefined;
      this.pendingUntilCycle = undefined;
    }
  }

  acknowledge(): void {
    this.pendingUntilCycle = undefined;
    if (!this.asserted) this.assertedAtCycle = undefined;
  }

  reset(): void {
    this.asserted = false;
    this.assertedAtCycle = undefined;
    this.pendingUntilCycle = undefined;
  }
}
