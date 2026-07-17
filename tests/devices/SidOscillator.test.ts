// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 振荡器测试
//
//   文件:       SidOscillator.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { SID_MODEL } from '../../src/devices/SidModel';
import { SidOscillator } from '../../src/devices/SidOscillator';
import { SID_CONTROL_BIT } from '../../src/devices/sidRegisters';

describe('SidOscillator', () => {
  it('delays MOS 8580 triangle/saw OSC readback by one cycle', () => {
    const mos6581 = new SidOscillator(SID_MODEL.mos6581);
    const mos8580 = new SidOscillator(SID_MODEL.mos8580);
    for (const oscillator of [mos6581, mos8580]) {
      oscillator.frequency = 0xffff;
      oscillator.setControl(SID_CONTROL_BIT.sawtooth);
      oscillator.clock();
      oscillator.updateWaveformOutput();
    }

    const current6581Readback = mos6581.oscillatorReadback;
    expect(mos8580.oscillatorReadback).not.toBe(current6581Readback);

    mos8580.clock();
    mos8580.updateWaveformOutput();
    expect(mos8580.oscillatorReadback).toBe(current6581Readback);
  });

  it('keeps oscillator phase across RES while clearing waveform selection', () => {
    const resetOscillator = new SidOscillator(SID_MODEL.mos6581);
    const uninterruptedOscillator = new SidOscillator(SID_MODEL.mos6581);
    for (const oscillator of [resetOscillator, uninterruptedOscillator]) {
      oscillator.frequency = 0x4321;
      oscillator.setControl(SID_CONTROL_BIT.sawtooth);
      for (let cycle = 0; cycle < 40; cycle += 1) oscillator.clock();
    }

    resetOscillator.reset();
    resetOscillator.setControl(SID_CONTROL_BIT.sawtooth);
    uninterruptedOscillator.updateWaveformOutput();

    expect(resetOscillator.oscillatorReadback).toBe(uninterruptedOscillator.oscillatorReadback);
  });
});
