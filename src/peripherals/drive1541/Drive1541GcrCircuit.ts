// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 GCR 读写分离电路
//
//   文件:       Drive1541GcrCircuit.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const DRIVE_1541_GCR_CIRCUIT = {
  bitsPerByte: 8,
  counterLimit: 16,
  fluxFilterStableTicks: 40,
  g64PrefilteredFluxTicks: 39,
  randomResetSeed: 0x1234_abcd,
  referenceClockHz: 16_000_000,
  shiftRegisterMask: 0x03ff,
  syncPattern: 0x03ff,
  weakFlux: {
    initialDelayMinimumTicks: 289,
    initialDelayRange: 31,
    repeatDelayMinimumTicks: 33,
    repeatDelayRange: 367,
  },
} as const;

const SO_MINIMUM_DELAY_TICKS = 10;
const REFERENCE_TICKS_PER_CPU_CYCLE = 16;
const UF4_SHIFT_PHASE_MASK = 0x03;
const UF4_SHIFT_PHASE = 0x02;
const UF4_COUNTER_MASK = 0x0f;
const WRITE_DATA_MOST_SIGNIFICANT_BIT = 0x80;

export type Drive1541SpeedZone = 0 | 1 | 2 | 3;
export type Drive1541GcrBit = 0 | 1;

export interface Drive1541GcrCircuitSignals {
  /** UE3 完成 SO 相位延迟后产生一个新的 BYTE READY 边沿。 */
  signalByteReady(dataByte: number): void;
  /** 写模式下每次 UF4 移位时送往写放大器的 NRZI 位。 */
  writeFluxBit(bit: Drive1541GcrBit): void;
}

/**
 * 复现 1541 的 UE7/UF4 分频、磁通滤波、十位同步检测和 UE3 字节计数。
 *
 * G64 已经把磁头脉冲量化为干净的位单元，因此 `observeRecordedFluxReversal` 会把
 * 滤波器推进到最后一个稳定确认时钟；没有磁通超过约 18 微秒时，读放大器使用固定
 * 种子的确定性弱磁通序列。固定种子不是把噪声伪装成媒体数据，而是让同一上电状态可
 * 重放、可保存并能由外部保护测试逐周期验证。
 */
export class Drive1541GcrCircuit {
  private speedZoneValue: Drive1541SpeedZone = 0;
  private readingValue = true;
  private byteReadyEnabledValue = true;
  private dataByteValue = 0;
  private writeDataByteValue = 0;

  private ue7Counter = 0;
  private uf4Counter = 0;
  private tenBitShiftRegister = 0;
  private byteBitCounter = 0;
  private writeShiftRegister = 0;
  private fluxFilterCounter = 0;
  private fluxState = 0;
  private acceptedFluxState = 0;
  private weakFluxCountdown: number = DRIVE_1541_GCR_CIRCUIT.weakFlux.initialDelayMinimumTicks;
  private randomState: number = DRIVE_1541_GCR_CIRCUIT.randomResetSeed;
  private soDelayTicks = 0;
  private referenceClockPhase = 0;

  constructor(private readonly signals: Drive1541GcrCircuitSignals) {}

  get speedZone(): Drive1541SpeedZone {
    return this.speedZoneValue;
  }

  get reading(): boolean {
    return this.readingValue;
  }

  get dataByte(): number {
    return this.dataByteValue;
  }

  get writeDataByte(): number {
    return this.writeDataByteValue;
  }

  get syncFound(): boolean {
    return this.readingValue && this.tenBitShiftRegister === DRIVE_1541_GCR_CIRCUIT.syncPattern;
  }

  /** 保存状态和确定性测试需要记录该计数；单位是 16 MHz 参考时钟。 */
  get weakFluxTicksRemaining(): number {
    return this.weakFluxCountdown;
  }

  /** 写模式调度器用它把媒体相位推进到下一次 UF4 移位边沿。 */
  get referenceTicksUntilNextShift(): number {
    let ticks = DRIVE_1541_GCR_CIRCUIT.counterLimit - this.ue7Counter;
    let counter = this.uf4Counter;
    for (;;) {
      counter = (counter + 1) & UF4_COUNTER_MASK;
      if ((counter & UF4_SHIFT_PHASE_MASK) === UF4_SHIFT_PHASE) return ticks;
      ticks += DRIVE_1541_GCR_CIRCUIT.counterLimit - this.speedZoneValue;
    }
  }

  reset(): void {
    this.dataByteValue = 0;
    this.ue7Counter = 0;
    this.uf4Counter = 0;
    this.tenBitShiftRegister = 0;
    this.byteBitCounter = 0;
    this.writeShiftRegister = 0;
    this.fluxFilterCounter = 0;
    this.fluxState = 0;
    this.acceptedFluxState = 0;
    this.weakFluxCountdown = DRIVE_1541_GCR_CIRCUIT.weakFlux.initialDelayMinimumTicks;
    this.randomState = DRIVE_1541_GCR_CIRCUIT.randomResetSeed;
    this.soDelayTicks = 0;
    this.referenceClockPhase = 0;
  }

  setSpeedZone(speedZone: Drive1541SpeedZone): void {
    this.speedZoneValue = requireSpeedZone(speedZone);
  }

  setReadMode(reading: boolean): void {
    this.readingValue = reading;
  }

  setByteReadyEnabled(enabled: boolean): void {
    this.byteReadyEnabledValue = enabled;
  }

  setWriteDataByte(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`1541 GCR write data must be one byte; received ${String(value)}.`);
    }
    this.writeDataByteValue = value;
  }

  /**
   * 提交 G64 位流中一个已经量化的磁通翻转。
   *
   * 原始模拟脉冲仍应经过完整 40 时钟滤波；G64 的位单元已经完成这一步，使用 39 只
   * 表示下一参考时钟锁存翻转，避免重复加入 2.5 微秒并改变镜像记录的脉冲位置。
   */
  observeRecordedFluxReversal(): void {
    if (!this.readingValue) return;
    this.fluxState ^= 1;
    this.fluxFilterCounter = DRIVE_1541_GCR_CIRCUIT.g64PrefilteredFluxTicks;
  }

  advance(referenceTicks: number): void {
    if (!Number.isSafeInteger(referenceTicks) || referenceTicks < 0) {
      throw new RangeError('1541 GCR reference ticks must be a non-negative safe integer.');
    }

    let remaining = referenceTicks;
    while (remaining > 0) {
      const interval = this.nextEventInterval(remaining);
      this.advanceSoDelay(interval);
      if (this.readingValue) this.advanceReadSeparator(interval);
      this.advanceDivider(interval);
      this.referenceClockPhase =
        (this.referenceClockPhase + interval) & (REFERENCE_TICKS_PER_CPU_CYCLE - 1);
      remaining -= interval;
    }
  }

  private nextEventInterval(remaining: number): number {
    let interval = remaining;
    interval = Math.min(interval, DRIVE_1541_GCR_CIRCUIT.counterLimit - this.ue7Counter);
    if (this.soDelayTicks > 0) interval = Math.min(interval, this.soDelayTicks);

    if (this.readingValue) {
      if (this.fluxFilterCounter < DRIVE_1541_GCR_CIRCUIT.fluxFilterStableTicks) {
        interval = Math.min(
          interval,
          DRIVE_1541_GCR_CIRCUIT.fluxFilterStableTicks - this.fluxFilterCounter,
        );
      }
      interval = Math.min(interval, this.weakFluxCountdown);
    }

    if (interval <= 0) {
      throw new Error('1541 GCR event scheduler reached a non-positive interval.');
    }
    return interval;
  }

  private advanceSoDelay(referenceTicks: number): void {
    if (this.soDelayTicks === 0) return;
    this.soDelayTicks -= referenceTicks;
    if (this.soDelayTicks < 0) {
      throw new Error('1541 GCR SO delay skipped its scheduled edge.');
    }
    if (this.soDelayTicks === 0) this.signals.signalByteReady(this.dataByteValue);
  }

  private advanceReadSeparator(referenceTicks: number): void {
    this.fluxFilterCounter += referenceTicks;
    if (
      this.fluxFilterCounter >= DRIVE_1541_GCR_CIRCUIT.fluxFilterStableTicks &&
      this.acceptedFluxState !== this.fluxState
    ) {
      this.acceptedFluxState = this.fluxState;
      this.resetPulseDivider();
      this.weakFluxCountdown = this.nextWeakFluxDelay(
        DRIVE_1541_GCR_CIRCUIT.weakFlux.initialDelayMinimumTicks,
        DRIVE_1541_GCR_CIRCUIT.weakFlux.initialDelayRange,
      );
      return;
    }

    this.weakFluxCountdown -= referenceTicks;
    if (this.weakFluxCountdown < 0) {
      throw new Error('1541 GCR weak-flux countdown skipped its scheduled transition.');
    }
    if (this.weakFluxCountdown !== 0) return;

    // 未格式化区域不会返回固定填充值；读放大器在长时间没有真实翻转后重新锁相，
    // 使软件观察到可重放但不恒定的弱位字节流。
    this.resetPulseDivider();
    this.weakFluxCountdown = this.nextWeakFluxDelay(
      DRIVE_1541_GCR_CIRCUIT.weakFlux.repeatDelayMinimumTicks,
      DRIVE_1541_GCR_CIRCUIT.weakFlux.repeatDelayRange,
    );
  }

  private resetPulseDivider(): void {
    this.ue7Counter = this.speedZoneValue;
    this.uf4Counter = 0;
  }

  private advanceDivider(referenceTicks: number): void {
    this.ue7Counter += referenceTicks;
    if (this.ue7Counter < DRIVE_1541_GCR_CIRCUIT.counterLimit) return;
    if (this.ue7Counter > DRIVE_1541_GCR_CIRCUIT.counterLimit) {
      throw new Error('1541 UE7 divider advanced past its carry boundary.');
    }

    this.ue7Counter = this.speedZoneValue;
    this.uf4Counter = (this.uf4Counter + 1) & UF4_COUNTER_MASK;
    if ((this.uf4Counter & UF4_SHIFT_PHASE_MASK) !== UF4_SHIFT_PHASE) return;
    this.shiftGcrData(referenceTicks);
  }

  private shiftGcrData(referenceTicks: number): void {
    const decodedBit = (((this.uf4Counter + 0x1c) >>> 4) & 1) as Drive1541GcrBit;
    this.tenBitShiftRegister =
      ((this.tenBitShiftRegister << 1) | decodedBit) & DRIVE_1541_GCR_CIRCUIT.shiftRegisterMask;

    const writeBit: Drive1541GcrBit =
      (this.writeShiftRegister & WRITE_DATA_MOST_SIGNIFICANT_BIT) === 0 ? 0 : 1;
    this.writeShiftRegister = (this.writeShiftRegister << 1) & 0xff;

    if (!this.readingValue) {
      this.signals.writeFluxBit(writeBit);
      this.byteBitCounter += 1;
      if (this.byteBitCounter !== DRIVE_1541_GCR_CIRCUIT.bitsPerByte) return;
      this.byteBitCounter = 0;
      this.writeShiftRegister = this.writeDataByteValue;
      this.scheduleByteReady(referenceTicks);
      return;
    }

    if (this.tenBitShiftRegister === DRIVE_1541_GCR_CIRCUIT.syncPattern) {
      this.byteBitCounter = 0;
      return;
    }

    this.byteBitCounter += 1;
    if (this.byteBitCounter !== DRIVE_1541_GCR_CIRCUIT.bitsPerByte) return;
    this.byteBitCounter = 0;
    this.dataByteValue = this.tenBitShiftRegister & 0xff;
    // 读写共用并行总线；进入写模式前最后读出的字节会留在串行写寄存器。
    this.writeShiftRegister = this.dataByteValue;
    this.scheduleByteReady(referenceTicks);
  }

  private scheduleByteReady(referenceTicks: number): void {
    if (!this.byteReadyEnabledValue) return;
    const shiftTickPhase =
      (this.referenceClockPhase + referenceTicks - 1) & (REFERENCE_TICKS_PER_CPU_CYCLE - 1);
    let delay = REFERENCE_TICKS_PER_CPU_CYCLE - shiftTickPhase;
    if (delay < SO_MINIMUM_DELAY_TICKS) delay += REFERENCE_TICKS_PER_CPU_CYCLE;
    this.soDelayTicks = delay;
  }

  private nextWeakFluxDelay(minimum: number, range: number): number {
    const value = this.nextRandomUint32();
    return minimum + ((value >>> 16) % range);
  }

  private nextRandomUint32(): number {
    let value = this.randomState;
    value = (value ^ (value << 13)) >>> 0;
    value = (value ^ (value >>> 17)) >>> 0;
    value = (value ^ (value << 5)) >>> 0;
    this.randomState = value;
    return value;
  }
}

function requireSpeedZone(speedZone: number): Drive1541SpeedZone {
  if (!Number.isInteger(speedZone) || speedZone < 0 || speedZone > 3) {
    throw new RangeError('1541 speed zone must be an integer from 0 through 3.');
  }
  return speedZone as Drive1541SpeedZone;
}
