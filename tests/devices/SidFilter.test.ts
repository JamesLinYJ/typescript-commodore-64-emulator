// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 内部滤波器测试
//
//   文件:       SidFilter.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { SidFilter } from '../../src/devices/SidFilter';
import { SID_MODEL } from '../../src/devices/SidModel';
import { SID_FILTER_BIT } from '../../src/devices/sidRegisters';

describe('SidFilter', () => {
  it('keeps MOS 8580 voice 3 audible through the filter when direct voice 3 is disabled', () => {
    const voice3 = 2_000 * 0xff;
    const direct = new SidFilter(SID_MODEL.mos8580, 1_000_000);
    direct.modeVolume = SID_FILTER_BIT.muteVoice3 | 0x0f;
    direct.clock([0, 0, voice3]);
    expect(direct.outputPcm).toBe(0);

    const routed = new SidFilter(SID_MODEL.mos8580, 1_000_000);
    routed.cutoff = 0x07ff;
    routed.resonanceRouting = SID_FILTER_BIT.voice3;
    routed.modeVolume = SID_FILTER_BIT.muteVoice3 | SID_FILTER_BIT.highPass | 0x0f;
    routed.clock([0, 0, voice3]);
    expect(routed.outputPcm).not.toBe(0);
  });

  it('resets filter registers and all integrator state', () => {
    const filter = new SidFilter(SID_MODEL.mos8580, 1_000_000);
    filter.cutoff = 0x0500;
    filter.resonanceRouting = 0xf1;
    filter.modeVolume = SID_FILTER_BIT.lowPass | 0x0f;
    for (let cycle = 0; cycle < 100; cycle += 1) filter.clock([300_000, 0, 0]);

    filter.reset();

    expect(filter.cutoff).toBe(0);
    expect(filter.resonanceRouting).toBe(0);
    expect(filter.modeVolume).toBe(0);
    expect(filter.outputPcm).toBe(0);
    expect(filter.clock([0, 0, 0])).toBe(0);
  });

  it('reproduces the MOS 6581 nonlinear low-pass impulse sequence', () => {
    const referenceClockHz = 1_000_000;
    const filter = new SidFilter(SID_MODEL.mos6581, referenceClockHz);
    const expectedPcm = [
      -3_271, -3_271, -3_289, -3_318, -3_357, -3_406, -3_468, -3_536, -3_608, -3_689, -3_782,
      -3_878,
    ];
    filter.cutoff = 0x0640;
    filter.resonanceRouting = 0xa0 | SID_FILTER_BIT.voice1;
    filter.modeVolume = SID_FILTER_BIT.lowPass | 0x0f;

    const actualPcm = expectedPcm.map((_, cycle) => {
      filter.clock([cycle === 0 ? 400_000 : 0, 0, 0]);
      return filter.outputPcm;
    });

    expect(actualPcm).toEqual(expectedPcm);
  });
});
