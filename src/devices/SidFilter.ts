// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 周期域滤波与混音
//
//   文件:       SidFilter.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Sid6581Filter } from './Sid6581Filter';
import { SID_MODEL, type SidModel } from './SidModel';
import { SID_FILTER_BIT, SID_MASK } from './sidRegisters';

export type { SidModel } from './SidModel';

const SIGNED_PCM_MINIMUM = -0x8000;
const SIGNED_PCM_MAXIMUM = 0x7fff;
const SIGNED_PCM_SCALE = 0x8000;
// 8580 固定点递推用 2^20 表示“每个约 1 MHz 芯片周期的角频率”。
const RESID_FREQUENCY_FRACTION_BITS = 20;
const MOS8580_MAXIMUM_CUTOFF_HZ_AT_1_MHZ = 12_500;
const MOS8580_ANGULAR_FREQUENCY_SCALE = Math.round(
  (2 ** RESID_FREQUENCY_FRACTION_BITS * 2 * Math.PI * MOS8580_MAXIMUM_CUTOFF_HZ_AT_1_MHZ) /
    1_000_000,
);
const MOS8580_RECIPROCAL_Q_SCALED = [
  1_448, 1_328, 1_218, 1_117, 1_024, 939, 861, 790, 724, 664, 609, 558, 512, 470, 431, 395,
] as const;
const MOS8580_RECIPROCAL_Q_FRACTION_BITS = 10;

const MOS8580_OP_AMP_MINIMUM_VOLTS = 1.3;
const MOS8580_OP_AMP_MAXIMUM_VOLTS = 8.91;
const MOS8580_VOICE_RANGE_VOLTS = 1;
const MOS8580_VOICE_SCALE = Math.trunc(
  (2 ** 14 * MOS8580_VOICE_RANGE_VOLTS) /
    (MOS8580_OP_AMP_MAXIMUM_VOLTS - MOS8580_OP_AMP_MINIMUM_VOLTS),
);
const MOS8580_VOICE_SCALE_FRACTION_BITS = 18;

/**
 * SID 内部滤波器和模拟混音器。
 *
 * 8580 使用逐周期固定点二积分环递推，可与独立参考实现逐样本比较。
 * 6581 使用独立的 NMOS 运放、VCR、非理想截止 DAC、求和器和增益梯形表，不借用
 * 8580 的线性参数。
 */
export class SidFilter {
  cutoff = 0;
  resonanceRouting = 0;
  modeVolume = 0;

  private lowPassState = 0;
  private bandPassState = 0;
  private highPassState = 0;
  private outputPcmState = 0;
  private readonly mos6581Filter: Sid6581Filter | undefined;

  constructor(
    readonly model: SidModel,
    processorClockHz: number,
  ) {
    if (!Number.isSafeInteger(processorClockHz) || processorClockHz <= 0) {
      throw new RangeError(`SID filter clock must be a positive integer: ${processorClockHz}.`);
    }
    this.mos6581Filter = model === SID_MODEL.mos6581 ? new Sid6581Filter() : undefined;
  }

  get output(): number {
    return this.outputPcmState / SIGNED_PCM_SCALE;
  }

  get outputPcm(): number {
    return this.outputPcmState;
  }

  reset(): void {
    this.cutoff = 0;
    this.resonanceRouting = 0;
    this.modeVolume = 0;
    this.lowPassState = 0;
    this.bandPassState = 0;
    this.highPassState = 0;
    this.outputPcmState = 0;
    this.mos6581Filter?.reset();
  }

  /** 声部输入使用 SidVoice.analogOutput 的乘法 DAC 整数量纲。 */
  clock(voice1: number, voice2: number, voice3: number, externalInput?: number): number {
    this.outputPcmState =
      this.model === SID_MODEL.mos8580
        ? this.clockMos8580(voice1, voice2, voice3, externalInput)
        : this.clockMos6581(voice1, voice2, voice3, externalInput);
    return this.output;
  }

  private clockMos8580(
    voice1: number,
    voice2: number,
    voice3: number,
    externalInput: number | undefined,
  ): number {
    const scaledVoice1 = scaleMos8580Voice(voice1);
    const scaledVoice2 = scaleMos8580Voice(voice2);
    const scaledVoice3 = scaleMos8580Voice(voice3);
    let filteredInput = 0;
    let directOutput = 0;
    if ((this.resonanceRouting & SID_FILTER_BIT.voice1) !== 0) filteredInput += scaledVoice1;
    else directOutput += scaledVoice1;
    if ((this.resonanceRouting & SID_FILTER_BIT.voice2) !== 0) filteredInput += scaledVoice2;
    else directOutput += scaledVoice2;
    if ((this.resonanceRouting & SID_FILTER_BIT.voice3) !== 0) filteredInput += scaledVoice3;
    else if ((this.modeVolume & SID_FILTER_BIT.muteVoice3) === 0) directOutput += scaledVoice3;
    if (externalInput !== undefined) {
      const scaledExternalInput = Math.trunc(externalInput);
      if ((this.resonanceRouting & SID_FILTER_BIT.externalInput) !== 0) {
        filteredInput += scaledExternalInput;
      } else {
        directOutput += scaledExternalInput;
      }
    }

    const angularFrequency = arithmeticShiftRight(
      MOS8580_ANGULAR_FREQUENCY_SCALE * (this.cutoff + 1),
      11,
    );
    const bandPassDelta = arithmeticShiftRight(
      angularFrequency * arithmeticShiftRight(this.highPassState, 4),
      16,
    );
    const lowPassDelta = arithmeticShiftRight(
      angularFrequency * arithmeticShiftRight(this.bandPassState, 4),
      16,
    );
    this.bandPassState -= bandPassDelta;
    this.lowPassState -= lowPassDelta;

    const resonance = (this.resonanceRouting >> 4) & SID_MASK.resonance;
    const reciprocalQ = MOS8580_RECIPROCAL_Q_SCALED[resonance];
    if (reciprocalQ === undefined) {
      throw new RangeError(`MOS 8580 resonance index ${resonance} is not defined.`);
    }
    this.highPassState =
      arithmeticShiftRight(this.bandPassState * reciprocalQ, MOS8580_RECIPROCAL_Q_FRACTION_BITS) -
      this.lowPassState -
      filteredInput;

    let mixed = directOutput;
    if ((this.modeVolume & SID_FILTER_BIT.lowPass) !== 0) mixed += this.lowPassState;
    if ((this.modeVolume & SID_FILTER_BIT.bandPass) !== 0) mixed += this.bandPassState;
    if ((this.modeVolume & SID_FILTER_BIT.highPass) !== 0) mixed += this.highPassState;

    const volume = this.modeVolume & SID_MASK.volume;
    return clampSignedPcm(arithmeticShiftRight(mixed * volume, 4));
  }

  private clockMos6581(
    voice1: number,
    voice2: number,
    voice3: number,
    externalInput: number | undefined,
  ): number {
    if (this.mos6581Filter === undefined) {
      throw new Error('MOS 6581 filter state is missing from a MOS 6581 SID instance.');
    }
    return this.mos6581Filter.clock(
      voice1,
      voice2,
      voice3,
      this.cutoff,
      this.resonanceRouting,
      this.modeVolume,
      externalInput,
    );
  }
}

function scaleMos8580Voice(value: number): number {
  return arithmeticShiftRight(value * MOS8580_VOICE_SCALE, MOS8580_VOICE_SCALE_FRACTION_BITS);
}

function clampSignedPcm(value: number): number {
  return Math.max(SIGNED_PCM_MINIMUM, Math.min(SIGNED_PCM_MAXIMUM, value));
}

/** JavaScript 位运算会先截成 32 位；这里按 C++ 有符号右移语义处理安全整数。 */
function arithmeticShiftRight(value: number, bits: number): number {
  return Math.floor(value / 2 ** bits);
}
