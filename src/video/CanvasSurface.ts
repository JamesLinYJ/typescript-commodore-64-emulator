// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Canvas 像素表面
//
//   文件:       CanvasSurface.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { PixelFrameBuffer } from './PixelFrameBuffer';

/**
 * PixelFrameBuffer 直接使用 ImageData 的 RGBA 存储。VIC-II 调色板在初始化时已经按
 * 平台端序打包，因此每条光栅线只复制一次，present 不再遍历整帧做颜色重排。
 */
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
    const rgbaWords = new Uint32Array(
      this.imageData.data.buffer,
      this.imageData.data.byteOffset,
      this.imageData.data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    );
    this.frameBuffer = new PixelFrameBuffer(width, height, rgbaWords);
  }

  clear(backgroundColor: number): void {
    this.frameBuffer.clear(backgroundColor);
  }

  present(): void {
    this.context.putImageData(this.imageData, 0, 0);
  }
}
