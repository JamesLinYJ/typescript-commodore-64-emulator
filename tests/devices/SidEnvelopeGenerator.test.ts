// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 包络发生器测试
//
//   文件:       SidEnvelopeGenerator.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { SidEnvelopeGenerator } from '../../src/devices/SidEnvelopeGenerator';
import { SID_CONTROL_BIT } from '../../src/devices/sidRegisters';

describe('SidEnvelopeGenerator', () => {
  it('keeps the envelope counter across RES while resetting its control state', () => {
    const envelope = new SidEnvelopeGenerator();
    envelope.writeAttackDecay(0x00);
    envelope.writeControl(SID_CONTROL_BIT.gate);
    for (let cycle = 0; cycle < 100; cycle += 1) envelope.clock();
    const outputBeforeReset = envelope.output;

    envelope.reset();

    expect(envelope.output).toBe(outputBeforeReset);
    expect(envelope.readback).toBe(outputBeforeReset);
  });

  it('samples the ENV3 readback before advancing the current envelope output', () => {
    const envelope = new SidEnvelopeGenerator();
    envelope.writeAttackDecay(0x00);
    envelope.writeControl(SID_CONTROL_BIT.gate);

    let observedPipelineDelay = false;
    for (let cycle = 0; cycle < 100; cycle += 1) {
      envelope.clock();
      if (envelope.output !== envelope.readback) {
        observedPipelineDelay = true;
        break;
      }
    }

    expect(observedPipelineDelay).toBe(true);
  });
});
