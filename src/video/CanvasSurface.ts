// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Canvas 像素表面
//
//   文件:       CanvasSurface.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { PixelFrameBuffer } from './PixelFrameBuffer';

export class CanvasSurface {
  readonly frameBuffer: PixelFrameBuffer;

  private readonly context: CanvasRenderingContext2D;
  private readonly imageData: ImageData;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly width: number,
    readonly height: number,
  ) {
    canvas.width = width;
    canvas.height = height;
    canvas.style.imageRendering = 'pixelated';

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser does not provide a 2D canvas context.');
    context.imageSmoothingEnabled = false;
    this.context = context;
    this.imageData = context.createImageData(width, height);
    this.frameBuffer = new PixelFrameBuffer(width, height);
  }

  clear(backgroundColor: number): void {
    this.frameBuffer.clear(backgroundColor);
  }

  present(): void {
    const output = this.imageData.data;
    const pixels = this.frameBuffer.pixels;

    let byteOffset = 0;
    for (const color of pixels) {
      output[byteOffset] = (color >> 16) & 0xff;
      output[byteOffset + 1] = (color >> 8) & 0xff;
      output[byteOffset + 2] = color & 0xff;
      output[byteOffset + 3] = (color >>> 24) & 0xff;
      byteOffset += 4;
    }
    this.context.putImageData(this.imageData, 0, 0);
  }
}
