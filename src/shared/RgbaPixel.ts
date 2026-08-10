// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Canvas 原生 RGBA 像素编码
//
//   文件:       RgbaPixel.ts
//
//   日期:       2026年08月10日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const PLATFORM_IS_LITTLE_ENDIAN = (() => {
  const word = new Uint32Array([0x01020304]);
  return new Uint8Array(word.buffer)[0] === 0x04;
})();

/** 把 RGBA 通道打包为当前平台 Uint32 写入后仍按 R、G、B、A 排列的字。 */
export function packRgbaPixel(red: number, green: number, blue: number, alpha = 0xff): number {
  const r = requireColorChannel('red', red);
  const g = requireColorChannel('green', green);
  const b = requireColorChannel('blue', blue);
  const a = requireColorChannel('alpha', alpha);
  return PLATFORM_IS_LITTLE_ENDIAN
    ? (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

function requireColorChannel(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`RGBA ${name} channel must be an integer from 0 through 255.`);
  }
  return value;
}
