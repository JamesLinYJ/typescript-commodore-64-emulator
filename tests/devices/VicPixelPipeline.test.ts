// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 逐周期像素管线测试
//
//   文件:       VicPixelPipeline.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { VicCycleSequencer } from '../../src/devices/VicCycleSequencer';
import { VicFetchPipeline } from '../../src/devices/VicFetchPipeline';
import { VicII } from '../../src/devices/VicII';
import type { VicMemoryBus } from '../../src/devices/VicMemoryBus';
import { VicPixelPipeline, type VicPixelRegisters } from '../../src/devices/VicPixelPipeline';
import type { VicSprite } from '../../src/devices/VicSprite';
import { PAL_VIC_TIMING } from '../../src/devices/VicTiming';
import {
  VIC_INTERRUPT_BIT,
  VIC_REGISTER,
  VIC_SCREEN_CONTROL_1_BIT,
  VIC_SCREEN_CONTROL_2_BIT,
} from '../../src/devices/vicRegisters';

class PixelTestMemory implements VicMemoryBus {
  readonly cpuDataBusValue = 0xff;
  readonly bytes = new Uint8Array(0x4000);
  readonly colors = new Uint8Array(0x0400);

  readVicByte(addressInBank: number): number {
    return this.bytes[addressInBank & 0x3fff] ?? 0;
  }

  readVicColor(index: number): number {
    return this.colors[index & 0x03ff] ?? 0;
  }
}

function runThrough(vic: VicII, memory: VicMemoryBus, rasterLine: number, cycle: number): void {
  const maximumCycles = 312 * 63;
  for (let elapsed = 0; elapsed < maximumCycles; elapsed += 1) {
    vic.tickCycle(memory);
    if (vic.currentRasterLine === rasterLine && vic.currentRasterCycle === cycle) return;
  }
  throw new Error(`VIC-II did not reach raster ${rasterLine}, cycle ${cycle}.`);
}

describe('VicPixelPipeline', () => {
  it('does not inspect the sprite table when the latched display mask is empty', () => {
    const cycle = new VicCycleSequencer().tick({
      displayEnabled: false,
      spriteEnableMask: 0,
      spriteVerticalExpansionMask: 0,
      spriteY: () => 0,
      verticalScroll: 0,
    });
    const fetch = new VicFetchPipeline();
    const emptySprites: readonly VicSprite[] = [];
    const inaccessibleSprites = new Proxy(emptySprites, {
      get: () => {
        throw new Error('The empty sprite table should not be inspected.');
      },
    });
    const black = 0xff000000;
    const registers: VicPixelRegisters = {
      backgroundColors: [black, black, black, black],
      bitmapMode: false,
      borderColor: black,
      displayModeValid: true,
      extendedBackgroundMode: false,
      horizontalScroll: 0,
      multicolorMode: false,
      palette: [black],
      screenVisible: false,
      spriteMulticolor0: black,
      spriteMulticolor1: black,
      sprites: inaccessibleSprites,
    };
    const pipeline = new VicPixelPipeline();

    expect(() =>
      pipeline.clockCycle(cycle, 0xff, registers, fetch, {
        recordSpriteForegroundCollision: () => {
          throw new Error('An empty sprite mask cannot collide with graphics.');
        },
        recordSpriteSpriteCollision: () => {
          throw new Error('An empty sprite mask cannot collide with another sprite.');
        },
      }),
    ).not.toThrow();
  });

  it('delays a changed border color by one dot across an eight-pixel batch', () => {
    const signals = {
      displayEnabled: true,
      spriteEnableMask: 0,
      spriteVerticalExpansionMask: 0,
      spriteY: () => 0,
      verticalScroll: 0,
    };
    const sequencer = new VicCycleSequencer();
    const fetch = new VicFetchPipeline();
    const pipeline = new VicPixelPipeline(PAL_VIC_TIMING, {
      firstVisibleCycle: 1,
      outputWidth: 16,
    });
    const black = 0xff000000;
    const red = 0xffe04040;
    const registers: VicPixelRegisters = {
      backgroundColors: [black, black, black, black],
      bitmapMode: false,
      borderColor: black,
      displayModeValid: true,
      extendedBackgroundMode: false,
      horizontalScroll: 0,
      multicolorMode: false,
      palette: [black],
      screenVisible: true,
      spriteMulticolor0: black,
      spriteMulticolor1: black,
      sprites: [],
    };
    const collisions = {
      recordSpriteForegroundCollision: () => undefined,
      recordSpriteSpriteCollision: () => undefined,
    };

    pipeline.clockCycle(sequencer.tick(signals), 0xff, registers, fetch, collisions);
    pipeline.clockCycle(
      sequencer.tick(signals),
      0xff,
      { ...registers, borderColor: red },
      fetch,
      collisions,
    );

    expect(Array.from(pipeline.snapshot())).toEqual([
      ...Array<number>(8).fill(black),
      black,
      ...Array<number>(7).fill(red),
    ]);
  });

  it('pipelines consecutive border writes without delaying background pixels', () => {
    const signals = {
      displayEnabled: false,
      spriteEnableMask: 0,
      spriteVerticalExpansionMask: 0,
      spriteY: () => 0,
      verticalScroll: 0,
    };
    const sequencer = new VicCycleSequencer();
    const fetch = new VicFetchPipeline();
    const pipeline = new VicPixelPipeline(PAL_VIC_TIMING, {
      firstVisibleCycle: 1,
      outputWidth: 32,
    });
    const black = 0xff000000;
    const red = 0xffe04040;
    const blue = 0xff4040e0;
    const green = 0xff40e040;
    const base: VicPixelRegisters = {
      backgroundColors: [black, black, black, black],
      bitmapMode: false,
      borderColor: black,
      displayModeValid: true,
      extendedBackgroundMode: false,
      horizontalScroll: 0,
      multicolorMode: false,
      palette: [black, red, blue, green],
      screenVisible: false,
      spriteMulticolor0: black,
      spriteMulticolor1: black,
      sprites: [],
    };
    const collisions = {
      recordSpriteForegroundCollision: () => undefined,
      recordSpriteSpriteCollision: () => undefined,
    };

    pipeline.clockCycle(sequencer.tick(signals), 0xff, base, fetch, collisions);
    pipeline.clockCycle(
      sequencer.tick(signals),
      0xff,
      { ...base, borderColor: red },
      fetch,
      collisions,
    );
    pipeline.clockCycle(
      sequencer.tick(signals),
      0xff,
      { ...base, borderColor: blue },
      fetch,
      collisions,
    );
    pipeline.clockCycle(
      sequencer.tick(signals),
      0x00,
      { ...base, backgroundColors: [green, black, black, black], borderColor: green },
      fetch,
      collisions,
    );

    expect(Array.from(pipeline.snapshot())).toEqual([
      ...Array<number>(8).fill(black),
      black,
      ...Array<number>(7).fill(red),
      red,
      ...Array<number>(7).fill(blue),
      ...Array<number>(8).fill(green),
    ]);
  });

  it('keeps the one-dot border phase across a raster-line boundary', () => {
    const signals = {
      displayEnabled: true,
      spriteEnableMask: 0,
      spriteVerticalExpansionMask: 0,
      spriteY: () => 0,
      verticalScroll: 0,
    };
    const sequencer = new VicCycleSequencer();
    const fetch = new VicFetchPipeline();
    const pipeline = new VicPixelPipeline(PAL_VIC_TIMING, {
      firstVisibleCycle: 1,
      outputWidth: 8,
    });
    const black = 0xff000000;
    const red = 0xffe04040;
    const blue = 0xff4040e0;
    const base: VicPixelRegisters = {
      backgroundColors: [black, black, black, black],
      bitmapMode: false,
      borderColor: black,
      displayModeValid: true,
      extendedBackgroundMode: false,
      horizontalScroll: 0,
      multicolorMode: false,
      palette: [black, red, blue],
      screenVisible: true,
      spriteMulticolor0: black,
      spriteMulticolor1: black,
      sprites: [],
    };
    const collisions = {
      recordSpriteForegroundCollision: () => undefined,
      recordSpriteSpriteCollision: () => undefined,
    };

    for (let cycle = 1; cycle < PAL_VIC_TIMING.cyclesPerRasterLine; cycle += 1) {
      pipeline.clockCycle(sequencer.tick(signals), 0xff, base, fetch, collisions);
    }
    pipeline.clockCycle(
      sequencer.tick(signals),
      0xff,
      { ...base, borderColor: red },
      fetch,
      collisions,
    );
    pipeline.clockCycle(
      sequencer.tick(signals),
      0xff,
      { ...base, borderColor: blue },
      fetch,
      collisions,
    );

    expect(Array.from(pipeline.snapshot())).toEqual([red, ...Array<number>(7).fill(blue)]);
  });

  it('renders a fetched text bit at the two-cycle graphics pipeline position', () => {
    const vic = new VicII();
    const memory = new PixelTestMemory();
    const verticalScroll = 3;
    memory.bytes[0x0400] = 0x00; // 屏幕码 0。
    memory.bytes[0x0000] = 0x80; // 字符 0 的第 0 行，仅最左像素置位。
    memory.colors[0] = 0x01;
    vic.write(
      VIC_REGISTER.screenControl1,
      VIC_SCREEN_CONTROL_1_BIT.displayEnable | VIC_SCREEN_CONTROL_1_BIT.rowSelect | verticalScroll,
    );
    vic.write(VIC_REGISTER.screenControl2, VIC_SCREEN_CONTROL_2_BIT.columnSelect);
    vic.write(VIC_REGISTER.memoryPointers, 0x10); // 屏幕矩阵 $0400，字符集 $0000。
    vic.write(VIC_REGISTER.backgroundColor0, 0x00);
    vic.write(VIC_REGISTER.borderColor, 0x06);

    runThrough(vic, memory, 0x33, 63);
    const line = vic.captureRasterLineState().pixels;

    expect(line[48]).toBe(vic.palette[1]);
    expect(line[49]).toBe(vic.palette[0]);
    expect(line[47]).toBe(vic.palette[6]);
  });

  it('latches sprite collisions without constructing a Canvas renderer', () => {
    const vic = new VicII();
    const memory = new PixelTestMemory();
    const spritePointer = 0x20;
    memory.bytes[0x03f8] = spritePointer;
    memory.bytes[0x03f9] = spritePointer;
    memory.bytes.fill(0xff, spritePointer << 6, (spritePointer << 6) + 63);
    vic.write(0x00, 80); // 精灵 0 X。
    vic.write(0x02, 80); // 精灵 1 X。
    vic.write(0x01, 0); // 精灵 0 Y。
    vic.write(0x03, 0); // 精灵 1 Y。
    vic.write(VIC_REGISTER.spriteEnable, 0x03);
    vic.write(VIC_REGISTER.interruptMask, VIC_INTERRUPT_BIT.spriteSpriteCollision);

    runThrough(vic, memory, 1, 30);

    expect(vic.interruptPending).toBe(true);
    expect(vic.read(VIC_REGISTER.spriteSpriteCollision)).toBe(0x03);
    expect(vic.read(VIC_REGISTER.interruptStatus) & VIC_INTERRUPT_BIT.spriteSpriteCollision).toBe(
      VIC_INTERRUPT_BIT.spriteSpriteCollision,
    );
  });

  it('keeps sprite collisions across the nine-bit X-counter wrap', () => {
    const vic = new VicII();
    const memory = new PixelTestMemory();
    const spritePointer = 0x20;
    memory.bytes[0x03f8] = spritePointer;
    memory.bytes[0x03f9] = spritePointer;
    memory.bytes.fill(0xff, spritePointer << 6, (spritePointer << 6) + 63);
    vic.write(0x00, 0xf8); // 精灵 0 从 X=$1F8 开始，跨过 9 位计数器的回绕点。
    vic.write(0x02, 0x00); // 精灵 1 从 X=$000 开始，与精灵 0 回绕后的 16 像素重合。
    vic.write(VIC_REGISTER.spriteXMostSignificantBits, 0x01);
    vic.write(0x01, 0x00);
    vic.write(0x03, 0x00);
    vic.write(VIC_REGISTER.spriteEnable, 0x03);

    runThrough(vic, memory, 1, 15);

    expect(vic.read(VIC_REGISTER.spriteSpriteCollision)).toBe(0x03);
  });

  it('detects sprite-to-foreground collision before the border output multiplexer', () => {
    const vic = new VicII();
    const memory = new PixelTestMemory();
    const spritePointer = 0x20;
    memory.bytes[0x0400] = 0x00;
    memory.bytes[0x0000] = 0x80;
    memory.colors[0] = 0x01;
    memory.bytes[0x03f8] = spritePointer;
    memory.bytes.fill(0xff, spritePointer << 6, (spritePointer << 6) + 63);
    vic.write(
      VIC_REGISTER.screenControl1,
      VIC_SCREEN_CONTROL_1_BIT.displayEnable | VIC_SCREEN_CONTROL_1_BIT.rowSelect | 3,
    );
    vic.write(VIC_REGISTER.screenControl2, VIC_SCREEN_CONTROL_2_BIT.columnSelect);
    vic.write(VIC_REGISTER.memoryPointers, 0x10);
    vic.write(0x00, 24); // 精灵最左像素落在画布 X=48，与字符首像素重合。
    vic.write(0x01, 0x32); // 前一行启动 DMA，数据在光栅 $33 输出。
    vic.write(VIC_REGISTER.spriteEnable, 0x01);

    runThrough(vic, memory, 0x33, 18);

    expect(vic.read(VIC_REGISTER.spriteForegroundCollision)).toBe(0x01);
    expect(
      vic.read(VIC_REGISTER.interruptStatus) & VIC_INTERRUPT_BIT.spriteForegroundCollision,
    ).toBe(VIC_INTERRUPT_BIT.spriteForegroundCollision);
  });
});
