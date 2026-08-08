// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 半周期总线计划
//
//   文件:       VicBusSchedule.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { VIC_SPRITE_COUNT } from './vicRegisters';
import { PAL_VIC_TIMING, type VicTiming } from './VicTiming';

export const VIC_BUS_PHASE = {
  phi1: 'phi1',
  phi2: 'phi2',
} as const;

export type VicBusPhase = (typeof VIC_BUS_PHASE)[keyof typeof VIC_BUS_PHASE];

export type VicPhi1Fetch =
  | { readonly kind: 'graphics'; readonly phase: 'phi1' }
  | { readonly kind: 'idle'; readonly phase: 'phi1' }
  | { readonly kind: 'refresh'; readonly phase: 'phi1' }
  | {
      readonly byteIndex: 1;
      readonly kind: 'spriteData';
      readonly phase: 'phi1';
      readonly spriteIndex: number;
    }
  | {
      readonly kind: 'spritePointer';
      readonly phase: 'phi1';
      readonly spriteIndex: number;
    };

export type VicPhi2Fetch =
  | { readonly kind: 'matrix'; readonly phase: 'phi2' }
  | {
      readonly byteIndex: 0 | 2;
      readonly kind: 'spriteData';
      readonly phase: 'phi2';
      readonly spriteIndex: number;
    };

export interface VicBusScheduleEntry {
  readonly cycle: number;
  readonly phi1: VicPhi1Fetch;
  readonly phi2: VicPhi2Fetch | undefined;
}

// 精灵 3 至 7 的取数跨越 PAL 行尾，因此所有周期计算都在 1..63 内回绕。
function wrapCycle(cycle: number, timing: VicTiming): number {
  return ((cycle - 1) % timing.cyclesPerRasterLine) + 1;
}

function defaultPhi1Fetch(cycle: number, timing: VicTiming): VicPhi1Fetch {
  if (cycle >= timing.fetch.refreshFirstCycle && cycle <= timing.fetch.refreshLastCycle) {
    return { kind: 'refresh', phase: VIC_BUS_PHASE.phi1 };
  }
  if (cycle >= timing.fetch.graphicsFirstCycle && cycle <= timing.fetch.graphicsLastCycle) {
    return { kind: 'graphics', phase: VIC_BUS_PHASE.phi1 };
  }
  if (cycle >= timing.fetch.idleFirstCycle && cycle <= timing.fetch.idleLastCycle) {
    return { kind: 'idle', phase: VIC_BUS_PHASE.phi1 };
  }
  throw new RangeError(`PAL VIC-II cycle ${cycle} has no Phi1 fetch assignment.`);
}

export function createVicBusSchedule(timing: VicTiming): readonly VicBusScheduleEntry[] {
  const phi1 = Array<VicPhi1Fetch | undefined>(timing.cyclesPerRasterLine + 1);
  const phi2 = Array<VicPhi2Fetch | undefined>(timing.cyclesPerRasterLine + 1);

  // C-access 只占用 φ2；同一 CPU 周期的 φ1 仍执行刷新、图形或精灵取数。
  for (
    let cycle = timing.fetch.matrixFirstCycle;
    cycle <= timing.fetch.matrixLastCycle;
    cycle += 1
  ) {
    phi2[cycle] = { kind: 'matrix', phase: VIC_BUS_PHASE.phi2 };
  }

  // 每个精灵先在 φ1 读取指针，再按 φ2、下一周期 φ1、φ2 读取三个数据字节。
  for (let spriteIndex = 0; spriteIndex < VIC_SPRITE_COUNT; spriteIndex += 1) {
    const pointerCycle = wrapCycle(
      timing.sprite.dataFirstCycle + spriteIndex * timing.sprite.startCycleSpacing,
      timing,
    );
    const remainingDataCycle = wrapCycle(pointerCycle + 1, timing);

    phi1[pointerCycle] = {
      kind: 'spritePointer',
      phase: VIC_BUS_PHASE.phi1,
      spriteIndex,
    };
    phi2[pointerCycle] = {
      byteIndex: 0,
      kind: 'spriteData',
      phase: VIC_BUS_PHASE.phi2,
      spriteIndex,
    };
    phi1[remainingDataCycle] = {
      byteIndex: 1,
      kind: 'spriteData',
      phase: VIC_BUS_PHASE.phi1,
      spriteIndex,
    };
    phi2[remainingDataCycle] = {
      byteIndex: 2,
      kind: 'spriteData',
      phase: VIC_BUS_PHASE.phi2,
      spriteIndex,
    };
  }

  return Object.freeze(
    Array.from({ length: timing.cyclesPerRasterLine }, (_, zeroBasedCycle) => {
      const cycle = zeroBasedCycle + 1;
      return Object.freeze({
        cycle,
        phi1: phi1[cycle] ?? defaultPhi1Fetch(cycle, timing),
        phi2: phi2[cycle],
      });
    }),
  );
}

const PAL_BUS_SCHEDULE = createVicBusSchedule(PAL_VIC_TIMING);

export function vicBusScheduleForCycle(cycle: number): VicBusScheduleEntry {
  const normalizedCycle = Math.trunc(cycle);
  if (normalizedCycle !== cycle || cycle < 1 || cycle > PAL_VIC_TIMING.cyclesPerRasterLine) {
    throw new RangeError(
      `PAL VIC-II cycle must be an integer from 1 through ${PAL_VIC_TIMING.cyclesPerRasterLine}; received ${cycle}.`,
    );
  }
  const entry = PAL_BUS_SCHEDULE[cycle - 1];
  if (!entry) throw new RangeError(`PAL VIC-II cycle ${cycle} is not present in the bus schedule.`);
  return entry;
}
