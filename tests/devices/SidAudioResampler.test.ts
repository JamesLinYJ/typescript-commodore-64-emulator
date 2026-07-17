// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 音频面积重采样测试
//
//   文件:       SidAudioResampler.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { SidAudioResampler } from '../../src/devices/SidAudioResampler';

describe('SidAudioResampler', () => {
  it('preserves a constant signal across a non-integer clock ratio', () => {
    const resampler = new SidAudioResampler(985_248, 44_100);
    const output: number[] = [];
    for (let cycle = 0; cycle < 985_248; cycle += 1) {
      const sample = resampler.push(0.375);
      if (sample !== undefined) output.push(sample);
    }

    expect(output).toHaveLength(44_100);
    expect(output.every((sample) => sample === 0.375)).toBe(true);
  });

  it('weights source cycles split by an output boundary without losing area', () => {
    const resampler = new SidAudioResampler(5, 2);
    const output = [1, 1, 0, 0, 0]
      .map((sample) => resampler.push(sample))
      .filter((sample): sample is number => sample !== undefined);

    expect(output).toEqual([0.8, 0]);
  });

  it('rejects unsupported upsampling instead of silently changing algorithms', () => {
    expect(() => new SidAudioResampler(44_100, 48_000)).toThrow(/does not support upsampling/);
  });
});
