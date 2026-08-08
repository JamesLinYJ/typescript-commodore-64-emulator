// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 主板输出滤波网络
//
//   文件:       SidExternalFilter.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

/**
 * C64 主板在 SID AUDIO OUT 后串接 10 kΩ/1000 pF 低通和 1 kΩ/10 µF 高通。
 *
 * 两级固定点递推分别保存低通节点电压与高通基准电压；系数在构造时按实际芯片时钟
 * 和 RC 时间常数计算，避免把“约 1 MHz”写成隐含常量。
 */
export class SidExternalFilter {
  private static readonly stateFractionBits = 11;
  private static readonly stateScale = 1 << SidExternalFilter.stateFractionBits;
  private static readonly stateReciprocal = 2 ** -SidExternalFilter.stateFractionBits;
  private static readonly lowPassCoefficientBits = 7;
  private static readonly lowPassCoefficientReciprocal =
    2 ** -SidExternalFilter.lowPassCoefficientBits;
  private static readonly highPassCoefficientBits = 17;
  private static readonly highPassCoefficientReciprocal =
    2 ** -SidExternalFilter.highPassCoefficientBits;

  private readonly lowPassCoefficient: number;
  private readonly highPassCoefficient: number;
  private lowPassState = 0;
  private highPassState = 0;

  constructor(processorClockHz: number) {
    if (!Number.isSafeInteger(processorClockHz) || processorClockHz <= 0) {
      throw new RangeError('SID external-filter clock must be a positive safe integer in hertz.');
    }

    const cycleSeconds = 1 / processorClockHz;
    const lowPassResistanceOhms = 10_000;
    const lowPassCapacitanceFarads = 1_000e-12;
    const highPassResistanceOhms = 1_000;
    const highPassCapacitanceFarads = 10e-6;
    this.lowPassCoefficient = quantizeRcCoefficient(
      cycleSeconds,
      lowPassResistanceOhms,
      lowPassCapacitanceFarads,
      SidExternalFilter.lowPassCoefficientBits,
    );
    this.highPassCoefficient = quantizeRcCoefficient(
      cycleSeconds,
      highPassResistanceOhms,
      highPassCapacitanceFarads,
      SidExternalFilter.highPassCoefficientBits,
    );
  }

  get outputPcm(): number {
    return Math.floor((this.lowPassState - this.highPassState) * SidExternalFilter.stateReciprocal);
  }

  reset(): void {
    this.lowPassState = 0;
    this.highPassState = 0;
  }

  clock(inputPcm: number): number {
    if (!Number.isInteger(inputPcm) || inputPcm < -0x8000 || inputPcm > 0x7fff) {
      throw new RangeError(`SID external-filter input must be signed 16-bit PCM: ${inputPcm}.`);
    }

    const scaledInput = inputPcm * SidExternalFilter.stateScale;
    // 三个除数都是固定的 2 的幂；预计算可精确表示的二进制倒数，避免在每个
    // SID 周期重复求幂和跨函数调用，Math.floor 仍保留 C++ 有符号右移的向下舍入。
    const lowPassDelta = Math.floor(
      this.lowPassCoefficient *
        (scaledInput - this.lowPassState) *
        SidExternalFilter.lowPassCoefficientReciprocal,
    );
    const highPassDelta = Math.floor(
      this.highPassCoefficient *
        (this.lowPassState - this.highPassState) *
        SidExternalFilter.highPassCoefficientReciprocal,
    );
    this.lowPassState += lowPassDelta;
    this.highPassState += highPassDelta;
    return this.outputPcm;
  }
}

function quantizeRcCoefficient(
  cycleSeconds: number,
  resistanceOhms: number,
  capacitanceFarads: number,
  fractionalBits: number,
): number {
  const coefficient = cycleSeconds / (cycleSeconds + resistanceOhms * capacitanceFarads);
  return Math.round(coefficient * 2 ** fractionalBits);
}
