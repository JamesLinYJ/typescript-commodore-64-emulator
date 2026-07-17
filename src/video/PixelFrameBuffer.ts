// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 像素帧缓冲区
//
//   文件:       PixelFrameBuffer.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

/** 只保存已经由 VIC-II 合成的最终 RGBA 像素，不参与任何硬件优先级判断。 */
export class PixelFrameBuffer {
  readonly pixels: Uint32Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new RangeError(`Pixel frame dimensions must be positive integers: ${width}x${height}.`);
    }
    this.pixels = new Uint32Array(width * height);
  }

  clear(color = 0): void {
    this.pixels.fill(color >>> 0);
  }

  writeRow(y: number, pixels: Uint32Array): void {
    if (!Number.isInteger(y) || y < 0 || y >= this.height) {
      throw new RangeError(`Pixel row ${y} is outside 0-${this.height - 1}.`);
    }
    if (pixels.length !== this.width) {
      throw new RangeError(
        `Pixel row width ${pixels.length} does not match frame width ${this.width}.`,
      );
    }
    this.pixels.set(pixels, y * this.width);
  }
}
