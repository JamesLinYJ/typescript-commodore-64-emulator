// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 主板输出滤波测试
//
//   文件:       SidExternalFilter.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { SidExternalFilter } from '../../src/devices/SidExternalFilter';

describe('SidExternalFilter', () => {
  it('reproduces the reSID one-megahertz fixed-point coefficients', () => {
    const filter = new SidExternalFilter(1_000_000);

    expect(filter.clock(0x4000)).toBe(1_536);
    expect(filter.clock(0x4000)).toBe(2_927);
  });

  it('removes a sustained DC level through the board high-pass network', () => {
    const filter = new SidExternalFilter(1_000_000);
    let output = 0;
    for (let cycle = 0; cycle < 150_000; cycle += 1) output = filter.clock(12_000);

    expect(Math.abs(output)).toBeLessThan(10);
  });

  it('rejects samples outside the signed 16-bit SID output range', () => {
    const filter = new SidExternalFilter(985_248);

    expect(() => filter.clock(0x8000)).toThrow(/signed 16-bit/);
    expect(() => filter.clock(-0x8001)).toThrow(/signed 16-bit/);
  });
});
