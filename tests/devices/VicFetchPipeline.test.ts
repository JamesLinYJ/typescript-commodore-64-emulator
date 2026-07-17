// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 内存取数流水线测试
//
//   文件:       VicFetchPipeline.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  VIC_MATRIX_ACCESS_SOURCE,
  type VicMatrixAccess,
} from '../../src/devices/VicBadLineController';
import { vicBusScheduleForCycle } from '../../src/devices/VicBusSchedule';
import type { VicCycleResult } from '../../src/devices/VicCycleSequencer';
import { VicFetchPipeline, type VicFetchRegisters } from '../../src/devices/VicFetchPipeline';
import type { VicMemoryBus } from '../../src/devices/VicMemoryBus';

class RecordingVicMemory implements VicMemoryBus {
  cpuDataBusValue = 0xff;
  readonly byteReads: number[] = [];
  readonly colorReads: number[] = [];
  readonly bytes = new Map<number, number>();
  readonly colors = new Map<number, number>();

  readVicByte(addressInBank: number): number {
    this.byteReads.push(addressInBank);
    return this.bytes.get(addressInBank) ?? 0;
  }

  readVicColor(index: number): number {
    this.colorReads.push(index);
    return this.colors.get(index) ?? 0;
  }
}

const TEXT_MODE_REGISTERS: VicFetchRegisters = {
  bitmapMemoryAddress: 0,
  bitmapMode: false,
  characterMemoryAddress: 0x1000,
  extendedBackgroundMode: false,
  screenMemoryAddress: 0x0400,
};

function createCycle(
  cycle: number,
  options: {
    readonly badLine?: boolean;
    readonly badLineCondition?: boolean;
    readonly enterDisplayState?: boolean;
    readonly frameStarted?: boolean;
    readonly lateVideoCounterReloadColumn?: number;
    readonly lineStarted?: boolean;
    readonly matrixAccess?: VicMatrixAccess;
    readonly phi1SpriteOffset?: number;
    readonly phi2SpriteOffset?: number;
    readonly spriteDisplayMask?: number;
  } = {},
): VicCycleResult {
  const badLine = options.badLine ?? false;
  const matrixAccess =
    options.matrixAccess ??
    (badLine && cycle >= 15 && cycle <= 54
      ? {
          column: cycle - 15,
          source: VIC_MATRIX_ACCESS_SOURCE.videoMemory,
        }
      : undefined);
  return {
    aecLow: false,
    baLow: badLine,
    badLine,
    badLineCondition: options.badLineCondition ?? badLine,
    busSchedule: vicBusScheduleForCycle(cycle),
    completedRasterLine: undefined,
    cycle,
    enterDisplayState: options.enterDisplayState ?? (badLine && cycle === 14),
    frameStarted: options.frameStarted ?? false,
    lateVideoCounterReloadColumn: options.lateVideoCounterReloadColumn,
    lineStarted: options.lineStarted ?? false,
    matrixAccess,
    rasterLine: 0,
    resetRowCounter: badLine && cycle === 14,
    spriteDataOffsets: {
      phi1: options.phi1SpriteOffset,
      phi2: options.phi2SpriteOffset,
    },
    spriteDisplayMask: options.spriteDisplayMask ?? 0,
    spriteDmaMask: 0,
  };
}

describe('VicFetchPipeline', () => {
  it('loads matrix data during Phi2 and uses it for the following Phi1 graphics fetch', () => {
    const pipeline = new VicFetchPipeline();
    const memory = new RecordingVicMemory();
    memory.bytes.set(0x0400, 0x2a);
    memory.bytes.set(0x1150, 0x5a);
    memory.colors.set(0, 0x0e);

    pipeline.executeCycle(createCycle(14, { badLine: true }), TEXT_MODE_REGISTERS, memory);
    pipeline.executeCycle(createCycle(15, { badLine: true }), TEXT_MODE_REGISTERS, memory);
    pipeline.executeCycle(createCycle(16, { badLine: true }), TEXT_MODE_REGISTERS, memory);

    const state = pipeline.snapshot();
    expect(state.screenMatrix[0]).toBe(0x2a);
    expect(state.colorMatrix[0]).toBe(0x0e);
    expect(state.graphics[0]).toBe(0x5a);
    expect(state.videoCounter).toBe(1);
    expect(memory.byteReads).toContain(0x1150);
    expect(memory.colorReads).toContain(0);
  });

  it('forms bitmap addresses from VC, RC, and the selected bitmap half', () => {
    const pipeline = new VicFetchPipeline();
    const memory = new RecordingVicMemory();
    const registers: VicFetchRegisters = {
      ...TEXT_MODE_REGISTERS,
      bitmapMemoryAddress: 0x2000,
      bitmapMode: true,
    };
    memory.bytes.set(0x2000, 0xa5);

    pipeline.executeCycle(createCycle(14, { badLine: true }), registers, memory);
    pipeline.executeCycle(createCycle(15, { badLine: true }), registers, memory);
    pipeline.executeCycle(createCycle(16, { badLine: true }), registers, memory);

    expect(pipeline.snapshot().graphics[0]).toBe(0xa5);
    expect(memory.byteReads).toContain(0x2000);
  });

  it('stores CPU-bus colors for the three delayed columns of a dynamic bad line', () => {
    const pipeline = new VicFetchPipeline();
    const memory = new RecordingVicMemory();
    memory.cpuDataBusValue = 0xab;
    memory.bytes.set(0x0403, 0x42);
    memory.colors.set(3, 0x05);

    pipeline.executeCycle(
      createCycle(21, {
        badLine: true,
        enterDisplayState: true,
        lateVideoCounterReloadColumn: 6,
        matrixAccess: { column: 6, source: VIC_MATRIX_ACCESS_SOURCE.cpuDataBus },
      }),
      TEXT_MODE_REGISTERS,
      memory,
    );
    pipeline.executeCycle(
      createCycle(22, {
        badLine: true,
        matrixAccess: { column: 7, source: VIC_MATRIX_ACCESS_SOURCE.cpuDataBus },
      }),
      TEXT_MODE_REGISTERS,
      memory,
    );
    pipeline.executeCycle(
      createCycle(23, {
        badLine: true,
        matrixAccess: { column: 8, source: VIC_MATRIX_ACCESS_SOURCE.cpuDataBus },
      }),
      TEXT_MODE_REGISTERS,
      memory,
    );
    pipeline.executeCycle(
      createCycle(24, {
        badLine: true,
        matrixAccess: { column: 9, source: VIC_MATRIX_ACCESS_SOURCE.videoMemory },
      }),
      TEXT_MODE_REGISTERS,
      memory,
    );

    const state = pipeline.snapshot();
    expect([...state.screenMatrix.slice(6, 10)]).toEqual([0xff, 0xff, 0xff, 0x42]);
    expect([...state.colorMatrix.slice(6, 10)]).toEqual([0x0b, 0x0b, 0x0b, 0x05]);
    expect(memory.colorReads).toEqual([3]);
  });

  it('fetches a sprite pointer and three DMA bytes in Phi1/Phi2 order', () => {
    const pipeline = new VicFetchPipeline();
    const memory = new RecordingVicMemory();
    memory.bytes.set(0x07f8, 0x20);
    memory.bytes.set(0x0800, 0x12);
    memory.bytes.set(0x0801, 0x34);
    memory.bytes.set(0x0802, 0x56);

    pipeline.executeCycle(createCycle(58, { phi2SpriteOffset: 0 }), TEXT_MODE_REGISTERS, memory);
    pipeline.executeCycle(
      createCycle(59, { phi1SpriteOffset: 1, phi2SpriteOffset: 2 }),
      TEXT_MODE_REGISTERS,
      memory,
    );
    const dmaReads = memory.byteReads.slice();
    pipeline.executeCycle(
      createCycle(10, { spriteDisplayMask: 0x01 }),
      TEXT_MODE_REGISTERS,
      memory,
    );

    const state = pipeline.snapshot();
    expect(state.spritePointers[0]).toBe(0x20);
    expect(state.spriteData[0]).toBe(0x123456);
    expect(state.spriteDisplayMask).toBe(0x01);
    expect(dmaReads).toEqual([0x07f8, 0x0800, 0x0801, 0x0802]);
  });
});
