// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 音频面积重采样器
//
//   文件:       SidAudioResampler.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

/**
 * 把 SID 周期域信号转换到音频采样率。
 *
 * 每个输入值视为保持一个芯片周期的分段常数，输出是采样区间上的精确面积平均值。
 * 相位和区间长度都以整数频率单位累计，因此 PAL 时钟与 44.1 kHz 之间不会产生浮点漂移。
 */
export class SidAudioResampler {
  private accumulatedArea = 0;
  private accumulatedWeight = 0;
  private weightUntilOutput: number;

  constructor(
    readonly inputRateHz: number,
    readonly outputRateHz: number,
  ) {
    if (!Number.isSafeInteger(inputRateHz) || inputRateHz <= 0) {
      throw new RangeError(`SID resampler input rate must be a positive integer: ${inputRateHz}.`);
    }
    if (!Number.isSafeInteger(outputRateHz) || outputRateHz <= 0) {
      throw new RangeError(
        `SID resampler output rate must be a positive integer: ${outputRateHz}.`,
      );
    }
    if (outputRateHz > inputRateHz) {
      throw new RangeError(
        `SID area resampler does not support upsampling ${inputRateHz} Hz to ${outputRateHz} Hz.`,
      );
    }
    this.weightUntilOutput = inputRateHz;
  }

  reset(): void {
    this.accumulatedArea = 0;
    this.accumulatedWeight = 0;
    this.weightUntilOutput = this.inputRateHz;
  }

  push(input: number): number | undefined {
    if (!Number.isFinite(input))
      throw new RangeError(`SID resampler input is not finite: ${input}.`);

    let inputWeightRemaining = this.outputRateHz;
    let output: number | undefined;
    while (inputWeightRemaining > 0) {
      const consumedWeight = Math.min(inputWeightRemaining, this.weightUntilOutput);
      this.accumulatedArea += input * consumedWeight;
      this.accumulatedWeight += consumedWeight;
      inputWeightRemaining -= consumedWeight;
      this.weightUntilOutput -= consumedWeight;

      if (this.weightUntilOutput === 0) {
        if (this.accumulatedWeight !== this.inputRateHz) {
          throw new Error(
            `SID resampler accumulated ${this.accumulatedWeight} weight units; expected ${this.inputRateHz}.`,
          );
        }
        output = this.accumulatedArea / this.accumulatedWeight;
        this.accumulatedArea = 0;
        this.accumulatedWeight = 0;
        this.weightUntilOutput = this.inputRateHz;
      }
    }
    return output;
  }
}
