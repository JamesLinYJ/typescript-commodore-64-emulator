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
    voice1: number,
    voice2: number,
    voice3: number,
    cutoff: number,
    resonanceRouting: number,
    modeVolume: number,
    externalInput?: number,
  ): number {
    this.updateCutoff(cutoff);
    const voice1Voltage = this.model.scaleVoice(voice1);
    const voice2Voltage = this.model.scaleVoice(voice2);
    const voice3Voltage = this.model.scaleVoice(voice3);
    let filterInputCount = 0;
    let filterInputVoltage = 0;
    let mixerInputCount = 0;
    let mixerInputVoltage = 0;

    if ((resonanceRouting & SID_FILTER_BIT.voice1) !== 0) {
      filterInputCount += 1;
      filterInputVoltage += voice1Voltage;
    } else {
      mixerInputCount += 1;
      mixerInputVoltage += voice1Voltage;
    }
    if ((resonanceRouting & SID_FILTER_BIT.voice2) !== 0) {
      filterInputCount += 1;
      filterInputVoltage += voice2Voltage;
    } else {
      mixerInputCount += 1;
      mixerInputVoltage += voice2Voltage;
    }
    if ((resonanceRouting & SID_FILTER_BIT.voice3) !== 0) {
      filterInputCount += 1;
      filterInputVoltage += voice3Voltage;
    } else if ((modeVolume & SID_FILTER_BIT.muteVoice3) === 0) {
      mixerInputCount += 1;
      mixerInputVoltage += voice3Voltage;
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
