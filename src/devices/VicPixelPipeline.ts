// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 逐周期像素管线
//
//   文件:       VicPixelPipeline.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { VicCycleResult } from './VicCycleSequencer';
import type { VicFetchPipeline } from './VicFetchPipeline';
import type { VicSprite } from './VicSprite';
import { PAL_VIC_TIMING, type VicTiming } from './VicTiming';

export interface VicPixelRegisters {
  readonly backgroundColors: readonly number[];
  readonly bitmapMode: boolean;
  readonly borderColor: number;
  readonly displayModeValid: boolean;
  readonly extendedBackgroundMode: boolean;
  readonly horizontalScroll: number;
  readonly multicolorMode: boolean;
  readonly palette: readonly number[];
  readonly screenVisible: boolean;
  readonly spriteMulticolor0: number;
  readonly spriteMulticolor1: number;
  readonly sprites: readonly VicSprite[];
}

export interface VicPixelCollisionSink {
  recordSpriteForegroundCollision(spriteMask: number): void;
  recordSpriteSpriteCollision(spriteMask: number): void;
}

export interface VicPixelPipelineOptions {
  readonly firstVisibleCycle?: number;
  readonly outputWidth?: number;
}

const PIXELS_PER_VIC_CYCLE = 8;
const TEXT_COLUMN_COUNT = 40;
const TEXT_COLUMN_WIDTH = 8;
const TEXT_DISPLAY_WIDTH = TEXT_COLUMN_COUNT * TEXT_COLUMN_WIDTH;
const SPRITE_SOURCE_WIDTH = 24;
const DEFAULT_FIRST_VISIBLE_CYCLE = 12;
const DEFAULT_OUTPUT_WIDTH = 403;
const TRANSPARENT_PIXEL = 0;
const VIC_X_COUNTER_MODULUS = 0x0200;
const VIC_X_COUNTER_MASK = VIC_X_COUNTER_MODULUS - 1;
const TEXT_DISPLAY_VIC_X = 0x18;
// PAL 光栅物理像素 112 对应 VIC 的 X=$000；可见裁剪从物理像素 88 开始。
const VIC_X_ZERO_PHYSICAL_PIXEL = 112;

/**
 * 在 VIC-II 时钟域内产生最终像素并锁存碰撞。
 *
 * PAL 6569 的 G-access 在周期 16..55 进行，字符移位器从周期 18 起输出，因此这里按
 * “输出周期 - 18”选择 40 个列锁存。寄存器在每个周期读取当前引脚状态，光栅中途写颜色、
 * 模式、X 坐标或优先级只影响后续像素；Canvas 不再重新读取可变寄存器。
 */
export class VicPixelPipeline {
  private readonly firstVisibleCycle: number;
  private readonly outputWidth: number;
  private readonly visibleCropPhysicalPixel: number;
  private readonly linePixels: Uint32Array;

  constructor(
    private readonly timing: VicTiming = PAL_VIC_TIMING,
    options: VicPixelPipelineOptions = {},
  ) {
    this.firstVisibleCycle = options.firstVisibleCycle ?? DEFAULT_FIRST_VISIBLE_CYCLE;
    this.outputWidth = options.outputWidth ?? DEFAULT_OUTPUT_WIDTH;
    if (!Number.isInteger(this.firstVisibleCycle) || this.firstVisibleCycle < 1) {
      throw new RangeError('VIC-II first visible cycle must be a positive integer.');
    }
    if (!Number.isInteger(this.outputWidth) || this.outputWidth <= 0) {
      throw new RangeError('VIC-II output width must be a positive integer.');
    }
    this.visibleCropPhysicalPixel = (this.firstVisibleCycle - 1) * PIXELS_PER_VIC_CYCLE;
    this.linePixels = new Uint32Array(this.outputWidth);
  }

  reset(borderColor: number): void {
    this.linePixels.fill(borderColor >>> 0);
  }

  clockCycle(
    cycle: VicCycleResult,
    borderPixelMask: number,
    registers: VicPixelRegisters,
    fetch: VicFetchPipeline,
    collisions: VicPixelCollisionSink,
  ): void {
    if (cycle.cycle < 1 || cycle.cycle > this.timing.cyclesPerRasterLine) {
      throw new RangeError(`VIC-II pixel cycle ${cycle.cycle} is outside the selected timing.`);
    }
    if (cycle.lineStarted) this.reset(registers.borderColor);

    const physicalCycleX = (cycle.cycle - 1) * PIXELS_PER_VIC_CYCLE;

    let spriteSpriteCollisionMask = 0;
    let spriteForegroundCollisionMask = 0;
    for (let pixelInCycle = 0; pixelInCycle < PIXELS_PER_VIC_CYCLE; pixelInCycle += 1) {
      const physicalX = physicalCycleX + pixelInCycle;
      const vicX = (physicalX - VIC_X_ZERO_PHYSICAL_PIXEL) & VIC_X_COUNTER_MASK;
      const outputX = physicalX - this.visibleCropPhysicalPixel;

      const graphics = this.graphicsPixel(vicX, registers, fetch);
      let outputColor = graphics.color;

      const sprites = this.spritePixel(vicX, registers, fetch);
      if ((sprites.mask & (sprites.mask - 1)) !== 0) {
        spriteSpriteCollisionMask |= sprites.mask;
      }
      if (graphics.foreground && sprites.mask !== 0) {
        spriteForegroundCollisionMask |= sprites.mask;
      }
      if (
        sprites.color !== TRANSPARENT_PIXEL &&
        !(graphics.foreground && sprites.behindForeground)
      ) {
        outputColor = sprites.color;
      }

      // 边框属于最终模拟多路器：它遮住可见颜色，但不抑制此前已经发生的精灵碰撞。
      if ((borderPixelMask & (0x80 >> pixelInCycle)) !== 0) {
        outputColor = registers.borderColor;
      }
      if (outputX >= 0 && outputX < this.outputWidth) {
        this.linePixels[outputX] = outputColor >>> 0;
      }
    }

    if (spriteSpriteCollisionMask !== 0) {
      collisions.recordSpriteSpriteCollision(spriteSpriteCollisionMask);
    }
    if (spriteForegroundCollisionMask !== 0) {
      collisions.recordSpriteForegroundCollision(spriteForegroundCollisionMask);
    }
  }

  snapshot(): Uint32Array {
    return this.linePixels.slice();
  }

  private graphicsPixel(
    vicX: number,
    registers: VicPixelRegisters,
    fetch: VicFetchPipeline,
  ): { readonly color: number; readonly foreground: boolean } {
    const background0 = registers.backgroundColors[0] ?? registers.palette[0] ?? 0xff000000;
    if (!registers.screenVisible) return { color: background0, foreground: false };
    if (!registers.displayModeValid) {
      return { color: registers.palette[0] ?? 0xff000000, foreground: true };
    }

    const displayX = vicX - TEXT_DISPLAY_VIC_X - registers.horizontalScroll;
    if (displayX < 0 || displayX >= TEXT_DISPLAY_WIDTH) {
      return { color: background0, foreground: false };
    }
    const column = Math.trunc(displayX / TEXT_COLUMN_WIDTH);
    const pixel = displayX % TEXT_COLUMN_WIDTH;
    const screenCode = fetch.screenMatrixByte(column);
    const colorRam = fetch.colorMatrixNibble(column);
    const graphics = fetch.graphicsByte(column);

    if (registers.bitmapMode) {
      return registers.multicolorMode
        ? this.multicolorBitmapPixel(pixel, graphics, screenCode, colorRam, registers)
        : this.highResolutionBitmapPixel(pixel, graphics, screenCode, registers);
    }
    return registers.multicolorMode && colorRam >= 8
      ? this.multicolorTextPixel(pixel, graphics, colorRam, registers)
      : this.highResolutionTextPixel(pixel, graphics, screenCode, colorRam, registers);
  }

  private highResolutionTextPixel(
    pixel: number,
    graphics: number,
    screenCode: number,
    colorRam: number,
    registers: VicPixelRegisters,
  ): { readonly color: number; readonly foreground: boolean } {
    const foreground = (graphics & (0x80 >> pixel)) !== 0;
    if (foreground) {
      return { color: registers.palette[colorRam] ?? registers.palette[0] ?? 0, foreground: true };
    }
    const backgroundIndex = registers.extendedBackgroundMode ? screenCode >> 6 : 0;
    return {
      color: registers.backgroundColors[backgroundIndex] ?? registers.backgroundColors[0] ?? 0,
      foreground: false,
    };
  }

  private multicolorTextPixel(
    pixel: number,
    graphics: number,
    colorRam: number,
    registers: VicPixelRegisters,
  ): { readonly color: number; readonly foreground: boolean } {
    const pair = Math.trunc(pixel / 2);
    const colorIndex = (graphics >> (6 - pair * 2)) & 0x03;
    const colors = [
      registers.backgroundColors[0] ?? 0,
      registers.backgroundColors[1] ?? 0,
      registers.backgroundColors[2] ?? 0,
      registers.palette[colorRam & 0x07] ?? 0,
    ] as const;
    return { color: colors[colorIndex] ?? 0, foreground: colorIndex >= 2 };
  }

  private highResolutionBitmapPixel(
    pixel: number,
    graphics: number,
    screenCode: number,
    registers: VicPixelRegisters,
  ): { readonly color: number; readonly foreground: boolean } {
    const foreground = (graphics & (0x80 >> pixel)) !== 0;
    const paletteIndex = foreground ? screenCode >> 4 : screenCode & 0x0f;
    return { color: registers.palette[paletteIndex] ?? 0, foreground };
  }

  private multicolorBitmapPixel(
    pixel: number,
    graphics: number,
    screenCode: number,
    colorRam: number,
    registers: VicPixelRegisters,
  ): { readonly color: number; readonly foreground: boolean } {
    const pair = Math.trunc(pixel / 2);
    const colorIndex = (graphics >> (6 - pair * 2)) & 0x03;
    const colors = [
      registers.backgroundColors[0] ?? 0,
      registers.palette[screenCode >> 4] ?? 0,
      registers.palette[screenCode & 0x0f] ?? 0,
      registers.palette[colorRam] ?? 0,
    ] as const;
    return { color: colors[colorIndex] ?? 0, foreground: colorIndex >= 2 };
  }

  private spritePixel(
    vicX: number,
    registers: VicPixelRegisters,
    fetch: VicFetchPipeline,
  ): { readonly behindForeground: boolean; readonly color: number; readonly mask: number } {
    let mask = 0;
    let selectedColor = TRANSPARENT_PIXEL;
    let selectedBehindForeground = false;
    const displayMask = fetch.spriteDisplayMask;

    for (let index = 0; index < registers.sprites.length; index += 1) {
      const sprite = registers.sprites[index];
      if (!sprite || (displayMask & (1 << index)) === 0) continue;
      const sourcePixel = spriteSourcePixel(vicX, sprite);
      if (sourcePixel === undefined) continue;

      const color = spritePixelColor(fetch.spriteDataWord(index), sourcePixel, sprite, registers);
      if (color === TRANSPARENT_PIXEL) continue;
      mask |= 1 << index;
      // VIC-II 的低编号精灵优先；循环顺序保证第一个非透明精灵保持可见。
      if (selectedColor === TRANSPARENT_PIXEL) {
        selectedColor = color;
        selectedBehindForeground = !sprite.foreground;
      }
    }

    return { behindForeground: selectedBehindForeground, color: selectedColor, mask };
  }
}

function spriteSourcePixel(vicX: number, sprite: VicSprite): number | undefined {
  const scale = sprite.expandHorizontal ? 2 : 1;
  const relativePixel = (vicX - sprite.x + VIC_X_COUNTER_MODULUS) & VIC_X_COUNTER_MASK;
  if (relativePixel >= SPRITE_SOURCE_WIDTH * scale) return undefined;
  return Math.trunc(relativePixel / scale);
}

function spritePixelColor(
  data: number,
  sourcePixel: number,
  sprite: VicSprite,
  registers: VicPixelRegisters,
): number {
  if (!sprite.multicolor) {
    return (data & (1 << (SPRITE_SOURCE_WIDTH - 1 - sourcePixel))) !== 0
      ? sprite.color
      : TRANSPARENT_PIXEL;
  }
  const pair = Math.trunc(sourcePixel / 2);
  const colorIndex = (data >> (SPRITE_SOURCE_WIDTH - 2 - pair * 2)) & 0x03;
  return (
    [TRANSPARENT_PIXEL, registers.spriteMulticolor0, sprite.color, registers.spriteMulticolor1][
      colorIndex
    ] ?? TRANSPARENT_PIXEL
  );
}
