// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 精灵 DMA 状态
//
//   文件:       VicSpriteDma.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

const SPRITE_DATA_ADDRESS_MASK = 0x3f;
const SPRITE_DATA_END = 0x3f;
const SPRITE_CRUNCH_AND_MASK = 0x2a;
const SPRITE_CRUNCH_OR_MASK = 0x15;

// MC 是当前取数字节偏移，MCBASE 是下一显示行的起点。垂直扩展触发器决定本行结束时是否推进 MCBASE。
export class VicSpriteDma {
  active = false;
  displayActive = false;
  expansionFlipFlop = true;
  memoryCounter = 0;
  memoryCounterBase = 0;

  start(): void {
    this.active = true;
    this.expansionFlipFlop = true;
    this.memoryCounter = 0;
    this.memoryCounterBase = 0;
  }

  updateMemoryCounterBase(): void {
    if (!this.active || !this.expansionFlipFlop) return;
    this.memoryCounterBase = this.memoryCounter;
    if (this.memoryCounterBase === SPRITE_DATA_END) this.active = false;
  }

  clockVerticalExpansion(expanded: boolean): void {
    if (this.active && expanded) this.expansionFlipFlop = !this.expansionFlipFlop;
  }

  clearVerticalExpansion(applyMemoryCounterCrunch: boolean): void {
    if (this.expansionFlipFlop) return;

    // 当 CPU 在 MCBASE 更新前一周期清除垂直扩展位时，真实 VIC-II 会把 MC 与 MCBASE
    // 的交错位组合回 MC；其它周期只把扩展触发器置位。二者都会让下一次 MCBASE 更新恢复。
    if (applyMemoryCounterCrunch) {
      this.memoryCounter =
        (SPRITE_CRUNCH_AND_MASK & (this.memoryCounterBase & this.memoryCounter)) |
        (SPRITE_CRUNCH_OR_MASK & (this.memoryCounterBase | this.memoryCounter));
    }
    this.expansionFlipFlop = true;
  }

  prepareDisplayRow(startDisplay: boolean): void {
    this.memoryCounter = this.memoryCounterBase;
    if (this.active) {
      if (startDisplay) this.displayActive = true;
    } else {
      this.displayActive = false;
    }
  }

  consumeDataByte(): number | undefined {
    if (!this.active) return undefined;
    const addressOffset = this.memoryCounter;
    this.memoryCounter = (this.memoryCounter + 1) & SPRITE_DATA_ADDRESS_MASK;
    return addressOffset;
  }

  reset(): void {
    this.active = false;
    this.displayActive = false;
    this.expansionFlipFlop = true;
    this.memoryCounter = 0;
    this.memoryCounterBase = 0;
  }
}
