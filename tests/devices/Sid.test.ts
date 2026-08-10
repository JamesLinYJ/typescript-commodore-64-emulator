// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 芯片行为测试
//
//   文件:       Sid.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { Sid } from '../../src/devices/Sid';
import { SID_MODEL } from '../../src/devices/SidModel';
import { SID_CONTROL_BIT, SID_FILTER_BIT, SID_REGISTER } from '../../src/devices/sidRegisters';

describe('Sid', () => {
  it('maps voice frequency, pulse width, and envelope registers', () => {
    const sid = new Sid();
    sid.write(0x00, 0x34);
    sid.write(0x01, 0x12);
    sid.write(0x02, 0xcd);
    sid.write(0x03, 0x0a);
    sid.write(0x05, 0x28);
    sid.write(0x06, 0xb4);

    expect(sid.getVoice(0)).toMatchObject({
      frequency: 0x1234,
      pulseWidth: 0x0acd,
      attackDecay: 0x28,
      sustainRelease: 0xb4,
    });
  });

  it('clocks the gate-controlled ADSR envelope', () => {
    const sid = new Sid();
    const powerOnEnvelope = sid.getVoice(0).envelope;
    sid.write(0x05, 0x00);
    sid.write(0x06, 0xf0);
    sid.write(0x04, SID_CONTROL_BIT.gate | SID_CONTROL_BIT.sawtooth);
    sid.tick(90);

    expect(sid.getVoice(0).envelope).toBeGreaterThan(powerOnEnvelope);
    const envelopeAfterAttack = sid.getVoice(0).envelope;

    sid.write(0x04, SID_CONTROL_BIT.sawtooth);
    sid.tick(180);
    expect(sid.getVoice(0).envelope).toBeLessThan(envelopeAfterAttack);
  });

  it('generates bounded PCM samples from three clocked voices', () => {
    const sid = new Sid(false, { processorClockHz: 100_000, sampleRateHz: 10_000 });
    sid.write(0x00, 0xff);
    sid.write(0x01, 0x7f);
    sid.write(0x05, 0x00);
    sid.write(0x06, 0xf0);
    sid.write(0x04, SID_CONTROL_BIT.gate | SID_CONTROL_BIT.sawtooth);
    sid.write(SID_REGISTER.filterModeVolume, SID_FILTER_BIT.lowPass | 0x0f);
    sid.tick(2_000);
    const samples = sid.drainSamples();

    expect(samples).toHaveLength(200);
    expect(samples.some((sample) => sample !== 0)).toBe(true);
    expect(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1)).toBe(true);
  });

  it('models the write-only data bus latch and readable paddle registers', () => {
    const sid = new Sid();
    sid.write(0x00, 0x73);
    expect(sid.read(0x00)).toBe(0x73);
    sid.tick(0x1cff);
    expect(sid.read(0x00)).toBe(0x73);
    sid.tick(1);
    expect(sid.read(0x00)).toBe(0x00);

    sid.setPaddleInputs(0x12, 0x34);
    expect(sid.read(SID_REGISTER.paddleX)).toBe(0x12);
    expect(sid.read(SID_REGISTER.paddleY)).toBe(0x34);
  });

  it('applies MOS 8580 register writes at the bus-write boundary', () => {
    const sid = new Sid(false, { model: SID_MODEL.mos8580 });

    sid.write(0x00, 0x34);

    expect(sid.getVoice(0).frequency).toBe(0x34);
    expect(sid.read(0x00)).toBe(0x34);
  });

  it('uses MOS 8580 writes on the next explicitly clocked chip cycle', () => {
    const sid = new Sid(false, { model: SID_MODEL.mos8580 });

    sid.write(0x00, 0xff);
    sid.tick(1);
    sid.write(0x01, 0xff);
    sid.tick(1);
    sid.write(0x04, SID_CONTROL_BIT.sawtooth);
    sid.tick(1);

    // C64Machine 会先推进当前总线周期再调用 write，因此每次写入都由下一个显式
    // SID 时钟使用：从上电累加器 $555555 开始，先增加 $00ff，再增加两次 $ffff。
    expect(sid.voices[0].waveform()).toBe(0x0575);
  });

  it('accepts consecutive MOS 8580 bus writes without a synthetic pipeline conflict', () => {
    const sid = new Sid(false, { model: SID_MODEL.mos8580 });
    sid.write(0x00, 0x34);
    sid.write(0x01, 0x12);

    expect(sid.getVoice(0).frequency).toBe(0x1234);
  });

  it.each([SID_MODEL.mos6581, SID_MODEL.mos8580])(
    'keeps clockCycle bit-identical to tick(1) for active %s voices and filters',
    (model) => {
      const singleCycle = new Sid(false, { model });
      const batched = new Sid(false, { model });
      const registers = [
        0x34,
        0x12,
        0x80,
        0x08,
        SID_CONTROL_BIT.gate | SID_CONTROL_BIT.noise | SID_CONTROL_BIT.synchronize,
        0x24,
        0xf8,
        0x45,
        0x23,
        0x55,
        0x05,
        SID_CONTROL_BIT.gate | SID_CONTROL_BIT.pulse,
        0x15,
        0xe6,
        0x56,
        0x34,
        0x00,
        0x00,
        SID_CONTROL_BIT.gate | SID_CONTROL_BIT.sawtooth,
        0x36,
        0xd7,
        0x07,
        0x90,
        0xf7,
        SID_FILTER_BIT.lowPass | SID_FILTER_BIT.bandPass | 0x0f,
      ];
      for (let register = 0; register < registers.length; register += 1) {
        const value = registers[register] ?? 0;
        singleCycle.write(register, value);
        batched.write(register, value);
      }

      for (let cycle = 0; cycle < 50_000; cycle += 1) {
        singleCycle.clockCycle();
        batched.tick(1);
      }

      expect(singleCycle.getVoice(0)).toEqual(batched.getVoice(0));
      expect(singleCycle.getVoice(1)).toEqual(batched.getVoice(1));
      expect(singleCycle.getVoice(2)).toEqual(batched.getVoice(2));
      expect(singleCycle.filterCutoff).toBe(batched.filterCutoff);
      expect(singleCycle.masterVolume).toBe(batched.masterVolume);
      expect(singleCycle.drainSamples()).toEqual(batched.drainSamples());
    },
  );
});
