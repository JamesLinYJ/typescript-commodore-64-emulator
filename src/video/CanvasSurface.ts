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

const PLATFORM_IS_LITTLE_ENDIAN = (() => {
  const word = new Uint32Array([0x01020304]);
  return new Uint8Array(word.buffer)[0] === 0x04;
})();

/**
 * 将芯片渲染层的 0xAARRGGBB 像素写入 ImageData 共享缓冲区。
 *
 * Uint32Array 视图让每个像素只做一次存储；端序分支在循环外选择，且不改变
 * Canvas 观察到的 R、G、B、A 字节顺序。destinationPixelOffset 便于将像素写入大图的子区域。
 */
export function copyArgbPixelsToRgbaWords(
  source: Uint32Array,
  destination: Uint32Array,
  destinationPixelOffset = 0,
): void {
  if (
    !Number.isInteger(destinationPixelOffset) ||
    destinationPixelOffset < 0 ||
    destinationPixelOffset + source.length > destination.length
  ) {
    throw new RangeError(
      `RGBA destination cannot hold ${source.length} pixels at offset ${destinationPixelOffset}.`,
    );
  }

  const end = destinationPixelOffset + source.length;
  let sourceOffset = 0;

  if (PLATFORM_IS_LITTLE_ENDIAN) {
    for (let outputOffset = destinationPixelOffset; outputOffset < end; outputOffset += 1) {
      const color = source[sourceOffset];
      if (color === undefined) {
        throw new RangeError(`ARGB source pixel ${sourceOffset} is unavailable.`);
      }
      destination[outputOffset] =
        (color & 0xff00ff00) | ((color & 0x000000ff) << 16) | ((color >>> 16) & 0xff);
      sourceOffset += 1;
    }
    return;
  }

  for (let outputOffset = destinationPixelOffset; outputOffset < end; outputOffset += 1) {
    const color = source[sourceOffset];
    if (color === undefined) {
      throw new RangeError(`ARGB source pixel ${sourceOffset} is unavailable.`);
    }
    destination[outputOffset] = (color << 8) | (color >>> 24);
    sourceOffset += 1;
  }
}

export class CanvasSurface {
  readonly frameBuffer: PixelFrameBuffer;

  private readonly context: CanvasRenderingContext2D;
  private readonly imageData: ImageData;
  private readonly rgbaWords: Uint32Array;

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
    this.rgbaWords = new Uint32Array(
      this.imageData.data.buffer,
      this.imageData.data.byteOffset,
      this.imageData.data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    );
    this.frameBuffer = new PixelFrameBuffer(width, height);
  }

  clear(backgroundColor: number): void {
    this.frameBuffer.clear(backgroundColor);
  }

  present(): void {
    copyArgbPixelsToRgbaWords(this.frameBuffer.pixels, this.rgbaWords);
    this.context.putImageData(this.imageData, 0, 0);
  }
}
