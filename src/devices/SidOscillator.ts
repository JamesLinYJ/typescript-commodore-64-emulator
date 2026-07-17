// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 振荡器
//
//   文件:       SidOscillator.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../shared/numbers';
import { SID_MODEL, type SidModel } from './SidModel';
import { SID_CONTROL_BIT, SID_MASK } from './sidRegisters';
import { sidWaveformTable } from './SidWaveformTables';

const OSCILLATOR_POWER_ON_ACCUMULATOR = 0x55_5555;
const NOISE_SHIFT_REGISTER_MASK = 0x7f_ffff;
const NOISE_SHIFT_REGISTER_RESET = 0x7f_fffe;
const NOISE_SHIFT_TRIGGER_BIT = 0x08_0000;
const OSCILLATOR_MSB = 0x80_0000;
const FREQUENCY_MASK = 0xffff;
const WAVEFORM_SELECTION_MASK = 0x0f;
const WAVEFORM_TABLE_INDEX_MASK = 0x07;
const WAVEFORM_NOISE_BIT = 0x08;
const WAVEFORM_PULSE_BIT = 0x04;
const WAVEFORM_SAWTOOTH_BIT = 0x02;
const WAVEFORM_TRIANGLE_SAW_MASK = 0x03;
const WAVEFORM_NOISE_PULSE_MASK = 0x0c;
const COMBINED_WAVEFORM_FIRST_INDEX = 0x09;
const NOISE_OUTPUT_REGISTER_MASK =
  (1 << 20) | (1 << 18) | (1 << 14) | (1 << 11) | (1 << 9) | (1 << 5) | (1 << 2) | 1;

const SID_OSCILLATOR_TIMING = {
  '6581': {
    floatingOutputFirstDecayCycles: 182_000,
    floatingOutputNextDecayCycles: 1_500,
    noiseResetFirstDecayCycles: 35_000,
    noiseResetNextDecayCycles: 1_000,
  },
  '8580': {
    floatingOutputFirstDecayCycles: 4_400_000,
    floatingOutputNextDecayCycles: 50_000,
    noiseResetFirstDecayCycles: 2_519_864,
    noiseResetNextDecayCycles: 315_000,
  },
} as const satisfies Record<SidModel, Record<string, number>>;

/**
 * 单个 SID 24 位相位累加器及其数字波形通路。
 *
 * 相位累加、噪声移位、TEST 延迟、环形调制和同步复位按单个 SID 周期依次推进。三个
 * 实例通过显式 source/destination 关系组成同步环，不把声部编号写死在振荡器内部。
 */
export class SidOscillator {
  private accumulator = OSCILLATOR_POWER_ON_ACCUMULATOR;
  private frequencyRegister = 0;
  private pulseWidthRegister = 0;
  private controlRegister = 0;
  private waveformSelection = 0;
  private waveformTable: Uint16Array;
  private model: SidModel;
  private testEnabled = false;
  private ringModulationEnabled = false;
  private syncEnabledState = false;
  private msbRising = false;
  private syncSource: SidOscillator = this;
  private syncDestination: SidOscillator = this;
  private noiseShiftRegister = NOISE_SHIFT_REGISTER_RESET;
  private noiseShiftResetCycles = 0;
  private noiseShiftPipeline = 0;
  private noiseOutput = 0;
  private noNoiseMask: number = SID_MASK.phaseWaveform;
  private noNoiseOrNoiseOutput: number = SID_MASK.phaseWaveform;
  private noPulseMask: number = SID_MASK.phaseWaveform;
  private pulseOutput: number = SID_MASK.phaseWaveform;
  private ringMostSignificantBitMask = 0;
  private waveformOutputValue = 0;
  private oscillatorReadbackValue = 0;
  private triangleSawPipeline = 0x0555;
  private floatingOutputCycles = 0;

  constructor(model: SidModel = SID_MODEL.mos6581) {
    this.model = model;
    this.waveformTable = sidWaveformTable(model, 0);
    this.reset();
  }

  get frequency(): number {
    return this.frequencyRegister;
  }

  set frequency(value: number) {
    this.frequencyRegister = Math.trunc(value) & FREQUENCY_MASK;
  }

  get pulseWidth(): number {
    return this.pulseWidthRegister;
  }

  set pulseWidth(value: number) {
    this.pulseWidthRegister = Math.trunc(value) & SID_MASK.pulseWidth;
    this.pulseOutput =
      this.accumulator >>> 12 >= this.pulseWidthRegister ? SID_MASK.phaseWaveform : 0;
  }

  get control(): number {
    return this.controlRegister;
  }

  get accumulatorMostSignificantBit(): boolean {
    return (this.accumulator & OSCILLATOR_MSB) !== 0;
  }

  get syncEnabled(): boolean {
    return this.syncEnabledState;
  }

  get waveformOutput(): number {
    return this.waveformOutputValue;
  }

  get oscillatorReadback(): number {
    return byte(this.oscillatorReadbackValue >> 4);
  }

  setSyncSource(source: SidOscillator): void {
    this.syncSource = source;
    source.syncDestination = this;
  }

  reset(): void {
    this.frequencyRegister = 0;
    this.pulseWidthRegister = 0;
    this.controlRegister = 0;
    this.waveformSelection = 0;
    this.waveformTable = sidWaveformTable(this.model, 0);
    this.testEnabled = false;
    this.ringModulationEnabled = false;
    this.syncEnabledState = false;
    this.msbRising = false;
    this.noiseShiftRegister = NOISE_SHIFT_REGISTER_RESET;
    this.noiseShiftResetCycles = 0;
    this.noiseShiftPipeline = 0;
    this.updateNoiseOutput();
    this.noNoiseMask = SID_MASK.phaseWaveform;
    this.noNoiseOrNoiseOutput = SID_MASK.phaseWaveform;
    this.noPulseMask = SID_MASK.phaseWaveform;
    this.pulseOutput = SID_MASK.phaseWaveform;
    this.ringMostSignificantBitMask = 0;
    this.waveformOutputValue = 0;
    this.oscillatorReadbackValue = 0;
    this.floatingOutputCycles = 0;

    // RES 不连接相位累加器和 8580 tri/saw 流水线，两者必须保留当前值。
  }

  setControl(value: number): void {
    const normalized = byte(value);
    const previousWaveform = this.waveformSelection;
    const previousTest = this.testEnabled;
    this.controlRegister = normalized;
    this.waveformSelection = (normalized >> 4) & WAVEFORM_SELECTION_MASK;
    this.testEnabled = (normalized & SID_CONTROL_BIT.test) !== 0;
    this.ringModulationEnabled = (normalized & SID_CONTROL_BIT.ringModulation) !== 0;
    this.syncEnabledState = (normalized & SID_CONTROL_BIT.synchronize) !== 0;
    this.waveformTable = sidWaveformTable(
      this.model,
      this.waveformSelection & WAVEFORM_TABLE_INDEX_MASK,
    );
    this.ringMostSignificantBitMask =
      this.ringModulationEnabled && (normalized & SID_CONTROL_BIT.sawtooth) === 0
        ? OSCILLATOR_MSB
        : 0;
    this.noNoiseMask =
      (this.waveformSelection & WAVEFORM_NOISE_BIT) !== 0 ? 0 : SID_MASK.phaseWaveform;
    this.noNoiseOrNoiseOutput = this.noNoiseMask | this.noiseOutput;
    this.noPulseMask =
      (this.waveformSelection & WAVEFORM_PULSE_BIT) !== 0 ? 0 : SID_MASK.phaseWaveform;

    if (!previousTest && this.testEnabled) {
      this.accumulator = 0;
      this.noiseShiftPipeline = 0;
      this.noiseShiftResetCycles = this.timing.noiseResetFirstDecayCycles;
      this.pulseOutput = SID_MASK.phaseWaveform;
    } else if (previousTest && !this.testEnabled) {
      if (this.shouldWriteBackBeforeTestRelease(previousWaveform, this.waveformSelection)) {
        this.writeNoiseShiftRegister();
      }
      const feedback = (~this.noiseShiftRegister >> 17) & 1;
      this.noiseShiftRegister =
        ((this.noiseShiftRegister << 1) | feedback) & NOISE_SHIFT_REGISTER_MASK;
      this.updateNoiseOutput();
    }

    if (this.waveformSelection !== 0) {
      this.updateWaveformOutput();
    } else if (previousWaveform !== 0) {
      this.floatingOutputCycles = this.timing.floatingOutputFirstDecayCycles;
    }
  }

  clock(): void {
    if (this.testEnabled) {
      if (this.noiseShiftResetCycles !== 0) {
        this.noiseShiftResetCycles -= 1;
        if (this.noiseShiftResetCycles === 0) this.fadeNoiseShiftRegister();
      }
      this.pulseOutput = SID_MASK.phaseWaveform;
      return;
    }

    const previousAccumulator = this.accumulator;
    const nextAccumulator = (previousAccumulator + this.frequencyRegister) & SID_MASK.accumulator;
    const accumulatorBitsSet = ~previousAccumulator & nextAccumulator;
    this.accumulator = nextAccumulator;
    this.msbRising = (accumulatorBitsSet & OSCILLATOR_MSB) !== 0;

    if ((accumulatorBitsSet & NOISE_SHIFT_TRIGGER_BIT) !== 0) {
      this.noiseShiftPipeline = 2;
    } else if (this.noiseShiftPipeline !== 0) {
      this.noiseShiftPipeline -= 1;
      if (this.noiseShiftPipeline === 0) this.clockNoiseShiftRegister();
    }
  }

  synchronizeDestination(): void {
    if (
      this.msbRising &&
      this.syncDestination.syncEnabledState &&
      !(this.syncEnabledState && this.syncSource.msbRising)
    ) {
      this.syncDestination.accumulator = 0;
    }
  }

  updateWaveformOutput(): void {
    if (this.waveformSelection !== 0) {
      const phaseIndex =
        ((this.accumulator ^ (~this.syncSource.accumulator & this.ringMostSignificantBitMask)) >>>
          12) &
        SID_MASK.phaseWaveform;
      const tableValue = this.waveformTable[phaseIndex];
      if (tableValue === undefined) {
        throw new RangeError(`SID waveform phase index is invalid: ${phaseIndex}.`);
      }
      this.waveformOutputValue =
        tableValue & (this.noPulseMask | this.pulseOutput) & this.noNoiseOrNoiseOutput;

      if ((this.waveformSelection & WAVEFORM_NOISE_PULSE_MASK) === WAVEFORM_NOISE_PULSE_MASK) {
        this.waveformOutputValue = this.applyNoisePulseCoupling(this.waveformOutputValue);
      }

      if (
        (this.waveformSelection & WAVEFORM_TRIANGLE_SAW_MASK) !== 0 &&
        this.model === SID_MODEL.mos8580
      ) {
        this.oscillatorReadbackValue =
          this.triangleSawPipeline &
          (this.noPulseMask | this.pulseOutput) &
          this.noNoiseOrNoiseOutput;
        this.triangleSawPipeline = tableValue;
      } else {
        this.oscillatorReadbackValue = this.waveformOutputValue;
      }

      if (
        (this.waveformSelection & WAVEFORM_SAWTOOTH_BIT) !== 0 &&
        (this.waveformSelection & 0x0d) !== 0 &&
        this.model === SID_MODEL.mos6581
      ) {
        this.accumulator &=
          (this.waveformOutputValue << 12) | (SID_MASK.accumulator ^ OSCILLATOR_MSB);
      }

      if (
        this.waveformSelection >= COMBINED_WAVEFORM_FIRST_INDEX &&
        !this.testEnabled &&
        this.noiseShiftPipeline !== 1
      ) {
        this.writeNoiseShiftRegister();
      }
    } else if (this.floatingOutputCycles !== 0) {
      this.floatingOutputCycles -= 1;
      if (this.floatingOutputCycles === 0) this.fadeFloatingWaveformOutput();
    }

    // 比较器结果在本周期末压入脉冲流水线，下次合成才生效。
    this.pulseOutput =
      this.accumulator >>> 12 >= this.pulseWidthRegister ? SID_MASK.phaseWaveform : 0;
  }

  private get timing(): (typeof SID_OSCILLATOR_TIMING)[SidModel] {
    return SID_OSCILLATOR_TIMING[this.model];
  }

  private clockNoiseShiftRegister(): void {
    const feedback = ((this.noiseShiftRegister >> 22) ^ (this.noiseShiftRegister >> 17)) & 1;
    this.noiseShiftRegister =
      ((this.noiseShiftRegister << 1) | feedback) & NOISE_SHIFT_REGISTER_MASK;
    this.updateNoiseOutput();
  }

  private updateNoiseOutput(): void {
    this.noiseOutput =
      ((this.noiseShiftRegister & 0x10_0000) >> 9) |
      ((this.noiseShiftRegister & 0x04_0000) >> 8) |
      ((this.noiseShiftRegister & 0x00_4000) >> 5) |
      ((this.noiseShiftRegister & 0x00_0800) >> 3) |
      ((this.noiseShiftRegister & 0x00_0200) >> 2) |
      ((this.noiseShiftRegister & 0x00_0020) << 1) |
      ((this.noiseShiftRegister & 0x00_0004) << 3) |
      ((this.noiseShiftRegister & 0x00_0001) << 4);
    this.noNoiseOrNoiseOutput = this.noNoiseMask | this.noiseOutput;
  }

  private writeNoiseShiftRegister(): void {
    this.noiseShiftRegister &=
      ~NOISE_OUTPUT_REGISTER_MASK |
      ((this.waveformOutputValue & 0x0800) << 9) |
      ((this.waveformOutputValue & 0x0400) << 8) |
      ((this.waveformOutputValue & 0x0200) << 5) |
      ((this.waveformOutputValue & 0x0100) << 3) |
      ((this.waveformOutputValue & 0x0080) << 2) |
      ((this.waveformOutputValue & 0x0040) >> 1) |
      ((this.waveformOutputValue & 0x0020) >> 3) |
      ((this.waveformOutputValue & 0x0010) >> 4);
    this.noiseShiftRegister &= NOISE_SHIFT_REGISTER_MASK;
    this.noiseOutput &= this.waveformOutputValue;
    this.noNoiseOrNoiseOutput = this.noNoiseMask | this.noiseOutput;
  }

  private fadeFloatingWaveformOutput(): void {
    this.waveformOutputValue &= this.waveformOutputValue >> 1;
    this.oscillatorReadbackValue = this.waveformOutputValue;
    if (this.waveformOutputValue !== 0) {
      this.floatingOutputCycles = this.timing.floatingOutputNextDecayCycles;
    }
  }

  private fadeNoiseShiftRegister(): void {
    this.noiseShiftRegister |= 1;
    this.noiseShiftRegister |= this.noiseShiftRegister << 1;
    this.noiseShiftRegister &= NOISE_SHIFT_REGISTER_MASK;
    this.updateNoiseOutput();
    if (this.noiseShiftRegister !== NOISE_SHIFT_REGISTER_MASK) {
      this.noiseShiftResetCycles = this.timing.noiseResetNextDecayCycles;
    }
  }

  private applyNoisePulseCoupling(noise: number): number {
    if (this.model === SID_MODEL.mos6581) {
      return noise < 0x0f00 ? 0 : noise & (noise << 1) & (noise << 2);
    }
    return noise < 0x0fc0 ? noise & (noise << 1) : 0x0fc0;
  }

  private shouldWriteBackBeforeTestRelease(
    previousWaveform: number,
    nextWaveform: number,
  ): boolean {
    if (previousWaveform <= WAVEFORM_NOISE_BIT) return false;
    if (previousWaveform === WAVEFORM_NOISE_PULSE_MASK) {
      if (this.model === SID_MODEL.mos6581) return false;
      if (nextWaveform !== 0x09 && nextWaveform !== 0x0e) return false;
    }
    if (
      this.model === SID_MODEL.mos6581 &&
      (((previousWaveform & WAVEFORM_TRIANGLE_SAW_MASK) === 1 &&
        (nextWaveform & WAVEFORM_TRIANGLE_SAW_MASK) === 2) ||
        ((previousWaveform & WAVEFORM_TRIANGLE_SAW_MASK) === 2 &&
          (nextWaveform & WAVEFORM_TRIANGLE_SAW_MASK) === 1))
    ) {
      return false;
    }
    return true;
  }
}
