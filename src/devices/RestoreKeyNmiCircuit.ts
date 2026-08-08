// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - RESTORE 键 NMI 单稳态电路
//
//   文件:       RestoreKeyNmiCircuit.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

/**
 * C64 主板上的 556 单稳态电路会把 RESTORE 按键的按下边沿转换成短 NMI 脉冲。
 * R24 与 C28 决定的典型脉宽约为 29 微秒，PAL 与 NTSC 机器上都可近似为 29 个主时钟周期。
 */
export const RESTORE_NMI_PULSE_CYCLES = 29;

/** 宿主输入适配器只依赖这个窄接口，不接触 CPU 或整机中断控制器。 */
export interface RestoreKeyInput {
  setRestoreKeyPressed(pressed: boolean): void;
}

export class RestoreKeyNmiCircuit implements RestoreKeyInput {
  private keyPressed = false;
  private pulseCyclesRemaining = 0;

  get nmiAsserted(): boolean {
    return this.pulseCyclesRemaining > 0;
  }

  setRestoreKeyPressed(pressed: boolean): void {
    if (pressed && !this.keyPressed && this.pulseCyclesRemaining === 0) {
      this.pulseCyclesRemaining = RESTORE_NMI_PULSE_CYCLES;
    }
    this.keyPressed = pressed;
  }

  tick(cycles: number): void {
    const elapsedCycles = Math.max(0, Math.trunc(cycles));
    this.pulseCyclesRemaining = Math.max(0, this.pulseCyclesRemaining - elapsedCycles);
  }

  /** 推进一个主时钟周期，供整机热路径跳过批量参数规范化。 */
  clockCycle(): void {
    if (this.pulseCyclesRemaining > 0) this.pulseCyclesRemaining -= 1;
  }

  reset(): void {
    this.keyPressed = false;
    this.pulseCyclesRemaining = 0;
  }
}
