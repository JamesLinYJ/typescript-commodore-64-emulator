// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 包络发生器
//
//   文件:       SidEnvelopeGenerator.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../shared/numbers';
import { SID_CONTROL_BIT, SID_ENVELOPE_RATE_COMPARE_VALUES } from './sidRegisters';

const ENVELOPE_COUNTER_MAXIMUM = 0xff;
const RATE_COUNTER_OVERFLOW_BIT = 0x8000;
const RATE_COUNTER_MASK = 0x7fff;
const POWER_ON_ENVELOPE_COUNTER = 0xaa;

const enum EnvelopeState {
  Attack,
  DecaySustain,
  Release,
}

const EXPONENTIAL_PERIOD_BY_ENVELOPE = new Map<number, number>([
  [0xff, 1],
  [0x5d, 2],
  [0x36, 4],
  [0x1a, 8],
  [0x0e, 16],
  [0x06, 30],
  [0x00, 1],
]);

/**
 * SID 的数字 ADSR 单元。
 *
 * 十五位速率计数器、指数分频计数器和延迟流水线均按单个 SID 周期推进。这里负责数字
 * 比较器与 ADSR 状态；音频 DAC 和滤波器的模拟非线性属于后续独立输出阶段。
 */
export class SidEnvelopeGenerator {
  private attack = 0;
  private decay = 0;
  private sustain = 0;
  private release = 0;
  private gate = false;
  private state = EnvelopeState.Release;
  private nextState = EnvelopeState.Release;
  private statePipeline = 0;
  private envelopeCounter = POWER_ON_ENVELOPE_COUNTER;
  private envelopeReadback = POWER_ON_ENVELOPE_COUNTER;
  private envelopePipeline = 0;
  private exponentialCounter = 0;
  private exponentialCounterPeriod = 1;
  private exponentialPipeline = 0;
  private holdZero = false;
  private rateCounter = 0;
  private ratePeriod = this.rateValue(this.release);
  private resetRateCounter = false;

  get output(): number {
    return this.envelopeCounter;
  }

  get readback(): number {
    return this.envelopeReadback;
  }

  reset(): void {
    this.attack = 0;
    this.decay = 0;
    this.sustain = 0;
    this.release = 0;
    this.gate = false;
    this.state = EnvelopeState.Release;
    this.statePipeline = 0;
    this.envelopePipeline = 0;
    this.exponentialCounter = 0;
    this.exponentialCounterPeriod = 1;
    this.exponentialPipeline = 0;
    this.holdZero = false;
    this.rateCounter = 0;
    this.ratePeriod = this.rateValue(this.release);
    this.resetRateCounter = false;

    // RES 不连接八位包络计数器；软复位必须保留当前电平，而不能人为清零。
    this.envelopeReadback = this.envelopeCounter;
  }

  writeControl(value: number): void {
    const nextGate = (value & SID_CONTROL_BIT.gate) !== 0;
    if (this.gate === nextGate) return;

    this.nextState = nextGate ? EnvelopeState.Attack : EnvelopeState.Release;
    if (this.nextState === EnvelopeState.Attack) {
      // Gate 上升后的第一个周期误用 decay 速率，第二个周期才切入 attack。
      this.state = EnvelopeState.DecaySustain;
      this.ratePeriod = this.rateValue(this.decay);
      this.statePipeline = 2;
      if (this.resetRateCounter || this.exponentialPipeline === 2) {
        this.envelopePipeline =
          this.exponentialCounterPeriod === 1 || this.exponentialPipeline === 2 ? 2 : 4;
      } else if (this.exponentialPipeline === 1) {
        this.statePipeline = 3;
      }
    } else {
      this.statePipeline = this.envelopePipeline > 0 ? 3 : 2;
    }
    this.gate = nextGate;
  }

  writeAttackDecay(value: number): void {
    const normalized = byte(value);
    this.attack = normalized >> 4;
    this.decay = normalized & 0x0f;
    if (this.state === EnvelopeState.Attack) {
      this.ratePeriod = this.rateValue(this.attack);
    } else if (this.state === EnvelopeState.DecaySustain) {
      this.ratePeriod = this.rateValue(this.decay);
    }
  }

  writeSustainRelease(value: number): void {
    const normalized = byte(value);
    this.sustain = normalized >> 4;
    this.release = normalized & 0x0f;
    if (this.state === EnvelopeState.Release) {
      this.ratePeriod = this.rateValue(this.release);
    }
  }

  clock(): void {
    // ENV3 在时钟第一相位采样，所以寄存器读回会比当前模拟包络电平落后一个周期。
    this.envelopeReadback = this.envelopeCounter;

    if (this.statePipeline !== 0) this.advanceStatePipeline();

    if (this.envelopePipeline !== 0) {
      this.envelopePipeline -= 1;
      if (this.envelopePipeline === 0 && !this.holdZero) {
        if (this.state === EnvelopeState.Attack) {
          this.envelopeCounter = byte(this.envelopeCounter + 1);
          if (this.envelopeCounter === ENVELOPE_COUNTER_MAXIMUM) {
            this.state = EnvelopeState.DecaySustain;
            this.ratePeriod = this.rateValue(this.decay);
          }
        } else {
          this.envelopeCounter = byte(this.envelopeCounter - 1);
        }
        this.updateExponentialPeriod();
      }
    }

    if (this.exponentialPipeline !== 0) {
      this.exponentialPipeline -= 1;
      if (this.exponentialPipeline === 0) {
        this.exponentialCounter = 0;
        if (
          (this.state === EnvelopeState.DecaySustain &&
            this.envelopeCounter !== this.sustainLevel()) ||
          this.state === EnvelopeState.Release
        ) {
          this.envelopePipeline = 1;
        }
      }
    } else if (this.resetRateCounter) {
      this.rateCounter = 0;
      this.resetRateCounter = false;

      if (this.state === EnvelopeState.Attack) {
        this.exponentialCounter = 0;
        this.envelopePipeline = 2;
      } else if (!this.holdZero) {
        this.exponentialCounter += 1;
        if (this.exponentialCounter === this.exponentialCounterPeriod) {
          this.exponentialPipeline = this.exponentialCounterPeriod === 1 ? 1 : 2;
        }
      }
    }

    // 比较值被写到当前计数器以下时不会立即触发，而会先绕过 15 位计数器；这就是 ADSR delay bug。
    if (this.rateCounter !== this.ratePeriod) {
      this.rateCounter += 1;
      if ((this.rateCounter & RATE_COUNTER_OVERFLOW_BIT) !== 0) {
        this.rateCounter = (this.rateCounter + 1) & RATE_COUNTER_MASK;
      }
    } else {
      this.resetRateCounter = true;
    }
  }

  private advanceStatePipeline(): void {
    this.statePipeline -= 1;
    if (this.nextState === EnvelopeState.Attack && this.statePipeline === 0) {
      this.state = EnvelopeState.Attack;
      this.ratePeriod = this.rateValue(this.attack);
      this.holdZero = false;
      return;
    }
    if (
      this.nextState === EnvelopeState.Release &&
      ((this.state === EnvelopeState.Attack && this.statePipeline === 0) ||
        (this.state === EnvelopeState.DecaySustain && this.statePipeline === 1))
    ) {
      this.state = EnvelopeState.Release;
      this.ratePeriod = this.rateValue(this.release);
    }
  }

  private updateExponentialPeriod(): void {
    const period = EXPONENTIAL_PERIOD_BY_ENVELOPE.get(this.envelopeCounter);
    if (period !== undefined) this.exponentialCounterPeriod = period;
    if (this.envelopeCounter === 0) this.holdZero = true;
  }

  private sustainLevel(): number {
    return this.sustain * 0x11;
  }

  private rateValue(index: number): number {
    const value = SID_ENVELOPE_RATE_COMPARE_VALUES[index];
    if (value === undefined) throw new RangeError(`SID envelope rate index is invalid: ${index}.`);
    return value;
  }
}
