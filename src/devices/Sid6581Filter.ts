// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6581 滤波器周期状态机
//
//   文件:       Sid6581Filter.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  getSid6581FilterModel,
  type Sid6581FilterModel,
  type Sid6581IntegratorState,
} from './Sid6581FilterModel';
import { SID_FILTER_BIT, SID_MASK } from './sidRegisters';

const SID_FILTER_INPUT_BITS = [
  SID_FILTER_BIT.voice1,
  SID_FILTER_BIT.voice2,
  SID_FILTER_BIT.voice3,
] as const;

/**
 * MOS 6581 的两个积分器环、共振反馈、模拟求和器与输出增益级。
 *
 * 该类只保存单颗芯片的电容和寄存器派生状态；非线性静态电路表由所有实例共享。
 */
export class Sid6581Filter {
  private readonly model: Sid6581FilterModel;
  private readonly bandPassIntegrator: Sid6581IntegratorState;
  private readonly lowPassIntegrator: Sid6581IntegratorState;
  private bandPassVoltage = 0;
  private cutoffRegister = -1;
  private cutoffVoltageSquared = 0;
  private highPassVoltage = 0;
  private lowPassVoltage = 0;

  constructor(model = getSid6581FilterModel()) {
    this.model = model;
    this.bandPassIntegrator = model.createIntegratorState();
    this.lowPassIntegrator = model.createIntegratorState();
    this.reset();
  }

  reset(): void {
    this.model.resetIntegratorState(this.bandPassIntegrator);
    this.model.resetIntegratorState(this.lowPassIntegrator);
    this.bandPassVoltage = 0;
    this.highPassVoltage = 0;
    this.lowPassVoltage = 0;
    this.cutoffRegister = 0;
    this.cutoffVoltageSquared = this.model.cutoffControlVoltageSquared(0);
  }

  clock(
    voices: readonly [number, number, number],
    cutoff: number,
    resonanceRouting: number,
    modeVolume: number,
    externalInput?: number,
  ): number {
    this.updateCutoff(cutoff);
    const voiceVoltages: [number, number, number] = [
      this.model.scaleVoice(voices[0]),
      this.model.scaleVoice(voices[1]),
      this.model.scaleVoice(voices[2]),
    ];
    let filterInputCount = 0;
    let filterInputVoltage = 0;
    let mixerInputCount = 0;
    let mixerInputVoltage = 0;

    for (let voice = 0; voice < voiceVoltages.length; voice += 1) {
      const voltage = voiceVoltages[voice];
      const routingBit = SID_FILTER_INPUT_BITS[voice];
      if (voltage === undefined || routingBit === undefined) {
        throw new RangeError(`MOS 6581 voice index ${voice} is not initialized.`);
      }
      if ((resonanceRouting & routingBit) !== 0) {
        filterInputCount += 1;
        filterInputVoltage += voltage;
        continue;
      }
      const voiceThreeMuted = voice === 2 && (modeVolume & SID_FILTER_BIT.muteVoice3) !== 0;
      if (!voiceThreeMuted) {
        mixerInputCount += 1;
        mixerInputVoltage += voltage;
      }
    }

    if (externalInput !== undefined) {
      const externalVoltage = this.model.scaleExternalInput(externalInput);
      if ((resonanceRouting & SID_FILTER_BIT.externalInput) !== 0) {
        filterInputCount += 1;
        filterInputVoltage += externalVoltage;
      } else {
        mixerInputCount += 1;
        mixerInputVoltage += externalVoltage;
      }
    }

    this.lowPassVoltage = this.model.integrate(
      this.bandPassVoltage,
      this.lowPassIntegrator,
      this.cutoffVoltageSquared,
    );
    this.bandPassVoltage = this.model.integrate(
      this.highPassVoltage,
      this.bandPassIntegrator,
      this.cutoffVoltageSquared,
    );
    const resonance = (resonanceRouting >> 4) & SID_MASK.resonance;
    const resonanceVoltage = this.model.resonanceGain(resonance, this.bandPassVoltage);
    this.highPassVoltage = this.model.sumFilterInputs(
      filterInputCount,
      resonanceVoltage + this.lowPassVoltage + filterInputVoltage,
    );

    if ((modeVolume & SID_FILTER_BIT.lowPass) !== 0) {
      mixerInputCount += 1;
      mixerInputVoltage += this.lowPassVoltage;
    }
    if ((modeVolume & SID_FILTER_BIT.bandPass) !== 0) {
      mixerInputCount += 1;
      mixerInputVoltage += this.bandPassVoltage;
    }
    if ((modeVolume & SID_FILTER_BIT.highPass) !== 0) {
      mixerInputCount += 1;
      mixerInputVoltage += this.highPassVoltage;
    }

    const mixedVoltage = this.model.mixAudioInputs(mixerInputCount, mixerInputVoltage);
    return this.model.applyVolume(modeVolume & SID_MASK.volume, mixedVoltage);
  }

  private updateCutoff(cutoff: number): void {
    const normalized = Math.trunc(cutoff);
    if (normalized === this.cutoffRegister) return;
    this.cutoffVoltageSquared = this.model.cutoffControlVoltageSquared(normalized);
    this.cutoffRegister = normalized;
  }
}
