// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 振荡器声部
//
//   文件:       SidVoice.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../shared/numbers';
import { SidEnvelopeGenerator } from './SidEnvelopeGenerator';
import type { SidModel } from './SidModel';
import { SidOscillator } from './SidOscillator';

// 数值来自 reSID 对真实芯片的测量：6581 的波形 DAC 零点明显偏离理想中点，
// 8580 也因其 DAC 传输特性使用不同零点。这里保留芯片型号差异，不能统一减去 $800。
const WAVEFORM_DAC_ZERO_BY_MODEL: Readonly<Record<SidModel, number>> = {
  '6581': 0x0380,
  '8580': 0x09e0,
};

export class SidVoice {
  private attackDecayRegister = 0;
  private sustainReleaseRegister = 0;
  private readonly envelope = new SidEnvelopeGenerator();
  private readonly oscillator: SidOscillator;
  private readonly waveformDacZero: number;

  constructor(model: SidModel) {
    this.oscillator = new SidOscillator(model);
    this.waveformDacZero = WAVEFORM_DAC_ZERO_BY_MODEL[model];
  }

  get frequency(): number {
    return this.oscillator.frequency;
  }

  set frequency(value: number) {
    this.oscillator.frequency = value;
  }

  get pulseWidth(): number {
    return this.oscillator.pulseWidth;
  }

  set pulseWidth(value: number) {
    this.oscillator.pulseWidth = value;
  }

  get control(): number {
    return this.oscillator.control;
  }

  get accumulatorMostSignificantBit(): boolean {
    return this.oscillator.accumulatorMostSignificantBit;
  }

  get envelopeOutput(): number {
    return this.envelope.output;
  }

  get envelopeReadback(): number {
    return this.envelope.readback;
  }

  /**
   * 返回送入 SID 模拟混音器的乘法 DAC 输出。
   *
   * 波形 DAC 的有符号输出乘以 8 位包络，量纲与 reSID 的 Voice::output 一致；
   * 滤波器再负责把这个芯片内部数值映射到模拟电压和最终 PCM。
   */
  get analogOutput(): number {
    return (this.oscillator.waveformOutput - this.waveformDacZero) * this.envelope.output;
  }

  get attackDecay(): number {
    return this.attackDecayRegister;
  }

  set attackDecay(value: number) {
    this.attackDecayRegister = byte(value);
    this.envelope.writeAttackDecay(this.attackDecayRegister);
  }

  get sustainRelease(): number {
    return this.sustainReleaseRegister;
  }

  set sustainRelease(value: number) {
    this.sustainReleaseRegister = byte(value);
    this.envelope.writeSustainRelease(this.sustainReleaseRegister);
  }

  reset(): void {
    this.attackDecayRegister = 0;
    this.sustainReleaseRegister = 0;
    this.oscillator.reset();
    this.envelope.reset();
  }

  setControl(value: number): void {
    const normalized = byte(value);
    this.oscillator.setControl(normalized);
    this.envelope.writeControl(normalized);
  }

  setSyncSource(source: SidVoice): void {
    this.oscillator.setSyncSource(source.oscillator);
  }

  clockOscillator(): void {
    this.oscillator.clock();
  }

  synchronizeOscillator(): void {
    this.oscillator.synchronizeDestination();
  }

  updateWaveformOutput(): void {
    this.oscillator.updateWaveformOutput();
  }

  clockEnvelope(): void {
    this.envelope.clock();
  }

  waveform(): number {
    return this.oscillator.waveformOutput;
  }

  readOscillator(): number {
    return this.oscillator.oscillatorReadback;
  }
}
