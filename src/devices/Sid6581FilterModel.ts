// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6581 非线性滤波器电路模型
//
//   文件:       Sid6581FilterModel.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

const NORMALIZED_VOLTAGE_LEVEL_COUNT = 1 << 16;
const NORMALIZED_VOLTAGE_MAXIMUM = NORMALIZED_VOLTAGE_LEVEL_COUNT - 1;
const NORMALIZED_VOLTAGE_MIDPOINT = 1 << 15;
const NORMALIZED_CAPACITOR_FRACTION_BITS = 15;
const FILTER_CUTOFF_LEVEL_COUNT = 1 << 11;
const FILTER_GAIN_LEVEL_COUNT = 1 << 4;
const FILTER_SUMMER_CONFIGURATION_COUNT = 5;
const AUDIO_MIXER_CONFIGURATION_COUNT = 8;
const SID_VOICE_DIGITAL_FRACTION_BITS = 18;
const SID_EXTERNAL_INPUT_FRACTION_BITS = 14;
const SID_EXTERNAL_INPUT_VOICE_SPAN = 3;
const SID_FILTER_REFERENCE_CLOCK_HZ = 1_000_000;

const MOS6581_OP_AMP_POINTS = [
  [0.81, 10.31],
  [0.81, 10.31],
  [2.4, 10.31],
  [2.6, 10.3],
  [2.7, 10.29],
  [2.8, 10.26],
  [2.9, 10.17],
  [3.0, 10.04],
  [3.1, 9.83],
  [3.2, 9.58],
  [3.3, 9.32],
  [3.5, 8.69],
  [3.7, 8.0],
  [4.0, 6.89],
  [4.4, 5.21],
  [4.54, 4.54],
  [4.6, 4.19],
  [4.8, 3.0],
  [4.9, 2.3],
  [4.95, 2.03],
  [5.0, 1.88],
  [5.05, 1.77],
  [5.1, 1.69],
  [5.2, 1.58],
  [5.4, 1.44],
  [5.6, 1.33],
  [5.8, 1.26],
  [6.0, 1.21],
  [6.4, 1.12],
  [7.0, 1.02],
  [7.5, 0.97],
  [8.5, 0.89],
  [10.0, 0.81],
  [10.31, 0.81],
  [10.31, 0.81],
] as const;

const MOS6581_VOICE_VOLTAGE_RANGE = 1.5;
const MOS6581_VOICE_DC_VOLTS = 5.0;
const MOS6581_CAPACITANCE_FARADS = 470e-12;
const MOS6581_SUPPLY_VOLTS = 12.18;
const MOS6581_THRESHOLD_VOLTS = 1.31;
const MOS6581_THERMAL_VOLTS = 26e-3;
const MOS6581_GATE_COUPLING = 1.0;
const MOS6581_TRANSISTOR_UCOX = 20e-6;
const MOS6581_VCR_WIDTH_LENGTH_RATIO = 9.0;
const MOS6581_SNAKE_WIDTH_LENGTH_RATIO = 1 / 115;
const MOS6581_CUTOFF_DAC_ZERO_VOLTS = 6.65;
const MOS6581_CUTOFF_DAC_SCALE_VOLTS = 2.63;
const MOS6581_CUTOFF_DAC_RESISTOR_RATIO = 2.2;
const MOS6581_DAC_LEAKAGE = 0.0075;

interface SplinePoint {
  readonly x: number;
  readonly y: number;
}

interface MutableIntegratorState {
  capacitorVoltage: number;
  opAmpInput: number;
}

interface OpAmpTransferTable {
  readonly derivative: Int16Array;
  readonly input: Uint16Array;
  readonly lowerRootBound: number;
  readonly upperRootBound: number;
}

/** MOS 6581 两个积分器各自持有电容电荷与运放输入，不能在声道或芯片实例之间共享。 */
export type Sid6581IntegratorState = MutableIntegratorState;

/**
 * MOS 6581 的归一化模拟电路查找表。
 *
 * 表只描述同一芯片修订版共有的静态电路传输函数；积分器电荷等时变状态由每个 SID
 * 实例单独持有。这样既避免每个芯片重复构造数百万个电压点，也不会让实例间串扰。
 */
export class Sid6581FilterModel {
  private readonly cutoffDac: Uint16Array;
  private readonly gain: Uint16Array;
  private readonly mixer: Uint16Array;
  private readonly opAmpReverse: Uint16Array;
  private readonly summer: Uint16Array;
  private readonly vcrGateVoltage: Uint16Array;
  private readonly vcrCurrentTerm: Uint16Array;
  private readonly voiceDc: number;
  private readonly voiceScale: number;
  private readonly normalizedSupplyThreshold: number;
  private readonly normalizedSnakeCurrent: number;

  constructor() {
    const minimumVoltage = MOS6581_OP_AMP_POINTS[0][0];
    const maximumOpAmpVoltage = MOS6581_OP_AMP_POINTS[0][1];
    const coupledSupplyThreshold =
      MOS6581_GATE_COUPLING * (MOS6581_SUPPLY_VOLTS - MOS6581_THRESHOLD_VOLTS);
    const maximumVoltage = Math.max(coupledSupplyThreshold, maximumOpAmpVoltage);
    const voltageSpan = maximumVoltage - minimumVoltage;
    const normalized16 = NORMALIZED_VOLTAGE_MAXIMUM / voltageSpan;
    const normalized16Integer = Math.trunc(normalized16);
    const normalized31 = (2 ** 31 - 1) / voltageSpan;

    this.voiceScale = Math.trunc((2 ** 14 / voltageSpan) * MOS6581_VOICE_VOLTAGE_RANGE);
    this.voiceDc = Math.trunc(normalized16 * (MOS6581_VOICE_DC_VOLTS - minimumVoltage));
    this.normalizedSupplyThreshold = Math.trunc(
      normalized16 * (coupledSupplyThreshold - minimumVoltage) + 0.5,
    );
    this.normalizedSnakeCurrent = Math.trunc(
      voltageSpan *
        2 ** 13 *
        ((MOS6581_TRANSISTOR_UCOX / (2 * MOS6581_GATE_COUPLING) / MOS6581_CAPACITANCE_FARADS) *
          MOS6581_SNAKE_WIDTH_LENGTH_RATIO *
          (1 / SID_FILTER_REFERENCE_CLOCK_HZ)) +
        0.5,
    );

    const opAmp = buildOpAmpTransferTable(normalized16, normalized31, minimumVoltage);
    this.gain = buildGainTable(opAmp, this.normalizedSupplyThreshold);
    this.summer = buildSummerTable(opAmp, this.normalizedSupplyThreshold);
    this.mixer = buildMixerTable(opAmp, this.normalizedSupplyThreshold);
    this.opAmpReverse = opAmp.input.slice();
    this.cutoffDac = buildCutoffDac(normalized16, minimumVoltage);
    this.vcrGateVoltage = buildVcrGateVoltageTable(normalized16Integer, minimumVoltage);
    this.vcrCurrentTerm = buildVcrCurrentTable(normalized16Integer);
  }

  createIntegratorState(): Sid6581IntegratorState {
    return { capacitorVoltage: 0, opAmpInput: 0 };
  }

  resetIntegratorState(state: Sid6581IntegratorState): void {
    state.capacitorVoltage = 0;
    state.opAmpInput = 0;
  }

  scaleVoice(sample: number): number {
    return (
      arithmeticShiftRight(Math.trunc(sample) * this.voiceScale, SID_VOICE_DIGITAL_FRACTION_BITS) +
      this.voiceDc
    );
  }

  scaleExternalInput(sample: number): number {
    return (
      arithmeticShiftRight(
        Math.trunc(sample) * this.voiceScale * SID_EXTERNAL_INPUT_VOICE_SPAN,
        SID_EXTERNAL_INPUT_FRACTION_BITS,
      ) + lookupTable(this.mixer, 0, 'MOS 6581 external-input DC level')
    );
  }

  cutoffControlVoltageSquared(cutoff: number): number {
    const normalizedCutoff = Math.trunc(cutoff);
    if (normalizedCutoff < 0 || normalizedCutoff >= FILTER_CUTOFF_LEVEL_COUNT) {
      throw new RangeError(`MOS 6581 cutoff index ${normalizedCutoff} is outside 0-$7ff.`);
    }
    const controlVoltage = this.cutoffDac[normalizedCutoff];
    if (controlVoltage === undefined) {
      throw new RangeError(`MOS 6581 cutoff index ${normalizedCutoff} is not initialized.`);
    }
    const difference = this.normalizedSupplyThreshold - controlVoltage;
    return Math.floor((difference * difference) / 2);
  }

  resonanceGain(resonance: number, bandPassVoltage: number): number {
    return this.lookupGain((~resonance & 0x0f) * NORMALIZED_VOLTAGE_LEVEL_COUNT + bandPassVoltage);
  }

  /**
   * 仅供 Sid6581Filter 内部逐周期路径调用。寄存器掩码把 resonance 限定为 0-15，
   * 积分器输出是 0-65535 的归一化电压，因此增益表索引必在 0-1,048,575 内。
   */
  resonanceGainUnchecked(resonance: number, bandPassVoltage: number): number {
    const index = (~resonance & 0x0f) * NORMALIZED_VOLTAGE_LEVEL_COUNT + bandPassVoltage;
    return this.gain[index]!;
  }

  sumFilterInputs(routedInputCount: number, voltageSum: number): number {
    return lookupTable(
      this.summer,
      summerOffset(routedInputCount) + voltageSum,
      'MOS 6581 filter summer',
    );
  }

  /**
   * 仅供 Sid6581Filter 内部逐周期路径调用。路由最多加入四个可变输入，再加两个滤波
   * 反馈输入，voltageSum 必在 0..(routedInputCount + 2) * 65535 的目标求和表分块内。
   */
  sumFilterInputsUnchecked(routedInputCount: number, voltageSum: number): number {
    const offset =
      ((routedInputCount * (routedInputCount + 3)) / 2) * NORMALIZED_VOLTAGE_LEVEL_COUNT;
    return this.summer[offset + voltageSum]!;
  }

  mixAudioInputs(inputCount: number, voltageSum: number): number {
    return lookupTable(this.mixer, mixerOffset(inputCount) + voltageSum, 'MOS 6581 audio mixer');
  }

  /**
   * 仅供 Sid6581Filter 内部逐周期路径调用。混音器最多接收七个声部、外部或滤波输出，
   * voltageSum 必在 0..inputCount * 65535 的目标混音表分块内。
   */
  mixAudioInputsUnchecked(inputCount: number, voltageSum: number): number {
    const offset =
      inputCount === 0
        ? 0
        : 1 + ((inputCount - 1) * inputCount * NORMALIZED_VOLTAGE_LEVEL_COUNT) / 2;
    return this.mixer[offset + voltageSum]!;
  }

  applyVolume(volume: number, mixedVoltage: number): number {
    return (
      this.lookupGain(volume * NORMALIZED_VOLTAGE_LEVEL_COUNT + mixedVoltage) -
      NORMALIZED_VOLTAGE_MIDPOINT
    );
  }

  /**
   * 仅供 Sid6581Filter 内部逐周期路径调用。volume 为 0-15，mixedVoltage 为
   * 0-65535 的归一化电压，组合索引必在增益表内。
   */
  applyVolumeUnchecked(volume: number, mixedVoltage: number): number {
    return (
      this.gain[volume * NORMALIZED_VOLTAGE_LEVEL_COUNT + mixedVoltage]! -
      NORMALIZED_VOLTAGE_MIDPOINT
    );
  }

  integrate(
    inputVoltage: number,
    state: Sid6581IntegratorState,
    cutoffVoltageSquared: number,
  ): number {
    if (!Number.isInteger(inputVoltage) || inputVoltage < 0 || inputVoltage > 0xffff) {
      throw new RangeError(`MOS 6581 integrator input voltage ${inputVoltage} is outside 0-65535.`);
    }
    if (!Number.isInteger(state.opAmpInput) || state.opAmpInput < 0 || state.opAmpInput > 0xffff) {
      throw new RangeError(
        `MOS 6581 integrator op-amp voltage ${state.opAmpInput} is outside 0-65535.`,
      );
    }
    if (!Number.isSafeInteger(state.capacitorVoltage)) {
      throw new RangeError(
        `MOS 6581 integrator capacitor voltage is not a safe integer: ${state.capacitorVoltage}.`,
      );
    }

    const gateDrain = this.normalizedSupplyThreshold - inputVoltage;
    const gateDrainSquared = Math.imul(gateDrain, gateDrain) >>> 0;
    const gateLookupIndex = Math.floor(
      (cutoffVoltageSquared + (gateDrainSquared >>> 1)) / NORMALIZED_VOLTAGE_LEVEL_COUNT,
    );
    if (
      !Number.isInteger(gateLookupIndex) ||
      gateLookupIndex < 0 ||
      gateLookupIndex >= this.vcrGateVoltage.length
    ) {
      throw new RangeError(
        `MOS 6581 VCR gate voltage index ${gateLookupIndex} is outside ` +
          `0-${this.vcrGateVoltage.length - 1}.`,
      );
    }
    return this.integrateUnchecked(inputVoltage, state, cutoffVoltageSquared);
  }

  /**
   * 仅供 Sid6581Filter 内部逐周期路径调用。inputVoltage 为 0-61898，opAmpInput 为
   * 0-61887，cutoffVoltageSquared 最大为 374,421,612，因此 gateLookupIndex 为
   * 0-38480，两个 VCR 电流表索引为 0-65535。反向运放索引依赖持续演化的电容状态，
   * 无法只凭本次输入静态界定，所以最后一次查表仍保留快速失败检查。外部调用者继续
   * 使用上方完整检查的 integrate()。
   */
  integrateUnchecked(
    inputVoltage: number,
    state: Sid6581IntegratorState,
    cutoffVoltageSquared: number,
  ): number {
    const supplyThreshold = this.normalizedSupplyThreshold;
    const gateSource = supplyThreshold - state.opAmpInput;
    const gateDrain = supplyThreshold - inputVoltage;
    const gateDrainSquared = Math.imul(gateDrain, gateDrain) >>> 0;
    const snakeDifference = (Math.imul(gateSource, gateSource) - gateDrainSquared) | 0;
    const snakeCurrent = this.normalizedSnakeCurrent * (snakeDifference >> 15);
    const gateLookupIndex = Math.floor(
      (cutoffVoltageSquared + (gateDrainSquared >>> 1)) / NORMALIZED_VOLTAGE_LEVEL_COUNT,
    );
    const gateVoltage = this.vcrGateVoltage[gateLookupIndex]!;
    const gateSourceVoltage = Math.max(0, gateVoltage - state.opAmpInput);
    const gateDrainVoltage = Math.max(0, gateVoltage - inputVoltage);
    const sourceCurrent = this.vcrCurrentTerm[gateSourceVoltage]!;
    const drainCurrent = this.vcrCurrentTerm[gateDrainVoltage]!;
    const vcrCurrent = Math.imul(sourceCurrent - drainCurrent, 1 << 15);

    state.capacitorVoltage = (state.capacitorVoltage - snakeCurrent - vcrCurrent) | 0;
    const reverseIndex =
      (state.capacitorVoltage >> NORMALIZED_CAPACITOR_FRACTION_BITS) + NORMALIZED_VOLTAGE_MIDPOINT;
    state.opAmpInput = lookupTable(
      this.opAmpReverse,
      reverseIndex,
      'MOS 6581 reverse op-amp transfer',
    );
    return state.opAmpInput + (state.capacitorVoltage >> 14);
  }

  private lookupGain(index: number): number {
    return lookupTable(this.gain, index, 'MOS 6581 gain ladder');
  }
}

let sharedModel: Sid6581FilterModel | undefined;

/** 静态电路表约占九 MiB；同一 JavaScript realm 中只构造并共享一份。 */
export function getSid6581FilterModel(): Sid6581FilterModel {
  sharedModel ??= new Sid6581FilterModel();
  return sharedModel;
}

function buildOpAmpTransferTable(
  normalized16: number,
  normalized31: number,
  minimumVoltage: number,
): OpAmpTransferTable {
  const scaledPoints = new Array<SplinePoint>(MOS6581_OP_AMP_POINTS.length);
  let sourceIndex = 0;
  for (const point of MOS6581_OP_AMP_POINTS) {
    scaledPoints[MOS6581_OP_AMP_POINTS.length - 1 - sourceIndex] = {
      x: Math.trunc(
        (normalized16 * (point[1] - point[0]) + NORMALIZED_VOLTAGE_LEVEL_COUNT) / 2 + 0.5,
      ),
      y: normalized31 * (point[0] - minimumVoltage),
    };
    sourceIndex += 1;
  }
  const lastIndex = scaledPoints.length - 1;
  const lastPoint = arrayValue(scaledPoints, lastIndex, 'MOS 6581 scaled op-amp point');
  if (lastPoint.x >= NORMALIZED_VOLTAGE_LEVEL_COUNT) {
    scaledPoints[lastIndex] = { ...lastPoint, x: NORMALIZED_VOLTAGE_MAXIMUM };
    const penultimatePoint = arrayValue(
      scaledPoints,
      lastIndex - 1,
      'MOS 6581 scaled op-amp point',
    );
    scaledPoints[lastIndex - 1] = {
      ...penultimatePoint,
      x: NORMALIZED_VOLTAGE_MAXIMUM,
    };
  }

  const interpolated = interpolateSpline(scaledPoints);
  const input = new Uint16Array(NORMALIZED_VOLTAGE_LEVEL_COUNT);
  const derivative = new Int16Array(NORMALIZED_VOLTAGE_LEVEL_COUNT);
  const lowerRootBound = arrayValue(scaledPoints, 0, 'MOS 6581 scaled op-amp point').x;
  const upperRootBound = arrayValue(scaledPoints, lastIndex, 'MOS 6581 scaled op-amp point').x;
  let previous = arrayValue(interpolated, lowerRootBound, 'MOS 6581 interpolated op-amp point');
  for (let index = lowerRootBound; index <= upperRootBound; index += 1) {
    const current = arrayValue(interpolated, index, 'MOS 6581 interpolated op-amp point');
    const delta = current - previous;
    input[index] =
      current > NORMALIZED_VOLTAGE_MAXIMUM * 2 ** 15
        ? NORMALIZED_VOLTAGE_MAXIMUM
        : arithmeticShiftRight(current, 15);
    derivative[index] = arithmeticShiftRight(delta, 4);
    previous = current;
  }
  return { derivative, input, lowerRootBound, upperRootBound };
}

function interpolateSpline(points: readonly SplinePoint[]): Uint32Array {
  const output = new Uint32Array(NORMALIZED_VOLTAGE_LEVEL_COUNT);
  for (let segment = 0; segment + 3 < points.length; segment += 1) {
    const point0 = arrayValue(points, segment, 'MOS 6581 spline control point');
    const point1 = arrayValue(points, segment + 1, 'MOS 6581 spline control point');
    const point2 = arrayValue(points, segment + 2, 'MOS 6581 spline control point');
    const point3 = arrayValue(points, segment + 3, 'MOS 6581 spline control point');
    if (point1.x === point2.x) continue;

    let slope1: number;
    let slope2: number;
    if (point0.x === point1.x && point2.x === point3.x) {
      slope1 = (point2.y - point1.y) / (point2.x - point1.x);
      slope2 = slope1;
    } else if (point0.x === point1.x) {
      slope2 = (point3.y - point1.y) / (point3.x - point1.x);
      slope1 = (3 * ((point2.y - point1.y) / (point2.x - point1.x)) - slope2) / 2;
    } else if (point2.x === point3.x) {
      slope1 = (point2.y - point0.y) / (point2.x - point0.x);
      slope2 = (3 * ((point2.y - point1.y) / (point2.x - point1.x)) - slope1) / 2;
    } else {
      slope1 = (point2.y - point0.y) / (point2.x - point0.x);
      slope2 = (point3.y - point1.y) / (point3.x - point1.x);
    }
    interpolateSplineSegment(output, point1, point2, slope1, slope2);
  }
  return output;
}

function interpolateSplineSegment(
  output: Uint32Array,
  start: SplinePoint,
  end: SplinePoint,
  startSlope: number,
  endSlope: number,
): void {
  const width = end.x - start.x;
  const height = end.y - start.y;
  const cubic = (startSlope + endSlope - (2 * height) / width) / (width * width);
  const quadratic = ((endSlope - startSlope) / width - 3 * (start.x + end.x) * cubic) / 2;
  const linear = startSlope - (3 * start.x * cubic + 2 * quadratic) * start.x;
  const constant = start.y - ((start.x * cubic + quadratic) * start.x + linear) * start.x;
  let value = ((cubic * start.x + quadratic) * start.x + linear) * start.x + constant;
  let delta = (3 * cubic * (start.x + 1) + 2 * quadratic) * start.x + (cubic + quadratic + linear);
  let secondDelta = 6 * cubic * (start.x + 1) + 2 * quadratic;
  const thirdDelta = 6 * cubic;
  for (let x = start.x; x <= end.x; x += 1) {
    output[Math.trunc(x)] = Math.trunc(Math.max(0, value) + 0.5);
    value += delta;
    delta += secondDelta;
    secondDelta += thirdDelta;
  }
}

function buildGainTable(opAmp: OpAmpTransferTable, supplyThreshold: number): Uint16Array {
  const table = new Uint16Array(FILTER_GAIN_LEVEL_COUNT * NORMALIZED_VOLTAGE_LEVEL_COUNT);
  for (let gain = 0; gain < FILTER_GAIN_LEVEL_COUNT; gain += 1) {
    let root = opAmp.lowerRootBound;
    const loading = gain << 4;
    const offset = gain * NORMALIZED_VOLTAGE_LEVEL_COUNT;
    for (let voltage = 0; voltage < NORMALIZED_VOLTAGE_LEVEL_COUNT; voltage += 1) {
      const packed = solveGain(opAmp, supplyThreshold, loading, voltage, root);
      root = Math.floor(packed / NORMALIZED_VOLTAGE_LEVEL_COUNT);
      table[offset + voltage] = packed & NORMALIZED_VOLTAGE_MAXIMUM;
    }
  }
  return table;
}

function buildSummerTable(opAmp: OpAmpTransferTable, supplyThreshold: number): Uint16Array {
  const table = new Uint16Array(summerOffset(FILTER_SUMMER_CONFIGURATION_COUNT));
  let offset = 0;
  for (
    let configuration = 0;
    configuration < FILTER_SUMMER_CONFIGURATION_COUNT;
    configuration += 1
  ) {
    const inputCount = configuration + 2;
    const size = inputCount * NORMALIZED_VOLTAGE_LEVEL_COUNT;
    let root = opAmp.lowerRootBound;
    for (let voltageSum = 0; voltageSum < size; voltageSum += 1) {
      const packed = solveGain(
        opAmp,
        supplyThreshold,
        inputCount << 7,
        Math.trunc(voltageSum / inputCount),
        root,
      );
      root = Math.floor(packed / NORMALIZED_VOLTAGE_LEVEL_COUNT);
      table[offset + voltageSum] = packed & NORMALIZED_VOLTAGE_MAXIMUM;
    }
    offset += size;
  }
  return table;
}

function buildMixerTable(opAmp: OpAmpTransferTable, supplyThreshold: number): Uint16Array {
  const table = new Uint16Array(mixerOffset(AUDIO_MIXER_CONFIGURATION_COUNT));
  let offset = 0;
  let size = 1;
  for (let configuration = 0; configuration < AUDIO_MIXER_CONFIGURATION_COUNT; configuration += 1) {
    const physicalInputCount = configuration;
    const divisor = Math.max(1, physicalInputCount);
    const loading = Math.trunc(((physicalInputCount << 7) * 8) / 6);
    let root = opAmp.lowerRootBound;
    for (let voltageSum = 0; voltageSum < size; voltageSum += 1) {
      const packed = solveGain(
        opAmp,
        supplyThreshold,
        loading,
        Math.trunc(voltageSum / divisor),
        root,
      );
      root = Math.floor(packed / NORMALIZED_VOLTAGE_LEVEL_COUNT);
      table[offset + voltageSum] = packed & NORMALIZED_VOLTAGE_MAXIMUM;
    }
    offset += size;
    size = (configuration + 1) * NORMALIZED_VOLTAGE_LEVEL_COUNT;
  }
  return table;
}

function solveGain(
  opAmp: OpAmpTransferTable,
  supplyThreshold: number,
  loading: number,
  inputVoltage: number,
  initialRoot: number,
): number {
  let lower = opAmp.lowerRootBound;
  let upper = opAmp.upperRootBound;
  let root = initialRoot;
  const scaledLoading = loading + (1 << 7);
  const supplyMinusInput = Math.max(0, supplyThreshold - inputVoltage);
  const inputCurrent = loading * Math.floor((supplyMinusInput * supplyMinusInput) / 2 ** 12);

  for (;;) {
    const previousRoot = root;
    const input = arrayValue(opAmp.input, root, 'MOS 6581 op-amp input');
    const derivative = arrayValue(opAmp.derivative, root, 'MOS 6581 op-amp derivative');
    let output = input + root * 2 - NORMALIZED_VOLTAGE_LEVEL_COUNT;
    output = Math.max(0, Math.min(NORMALIZED_VOLTAGE_MAXIMUM, output));
    const supplyMinusOpAmp = Math.max(0, supplyThreshold - input);
    const supplyMinusOutput = Math.max(0, supplyThreshold - output);
    const value =
      scaledLoading * Math.floor((supplyMinusOpAmp * supplyMinusOpAmp) / 2 ** 12) -
      inputCurrent -
      Math.floor((supplyMinusOutput * supplyMinusOutput) / 2 ** 5);
    const divisor = arithmeticShiftRight(
      arithmeticShiftRight(supplyMinusOutput * (derivative + (1 << 11)), 1) -
        scaledLoading * arithmeticShiftRight(supplyMinusOpAmp * derivative, 8),
      14,
    );
    if (divisor !== 0) root -= Math.trunc(value / divisor);
    if (root === previousRoot) return root * NORMALIZED_VOLTAGE_LEVEL_COUNT + output;

    if (value < 0) lower = previousRoot;
    else upper = previousRoot;
    if (root <= lower || root >= upper) {
      root = arithmeticShiftRight(lower + upper, 1);
      if (root === lower) return root * NORMALIZED_VOLTAGE_LEVEL_COUNT + output;
    }
  }
}

function buildCutoffDac(normalized16: number, minimumVoltage: number): Uint16Array {
  const rawDac = buildDacTable(11, MOS6581_CUTOFF_DAC_RESISTOR_RATIO, false);
  const output = new Uint16Array(FILTER_CUTOFF_LEVEL_COUNT);
  for (let value = 0; value < FILTER_CUTOFF_LEVEL_COUNT; value += 1) {
    output[value] = Math.trunc(
      normalized16 *
        (MOS6581_CUTOFF_DAC_ZERO_VOLTS +
          (arrayValue(rawDac, value, 'MOS 6581 cutoff DAC') * MOS6581_CUTOFF_DAC_SCALE_VOLTS) /
            FILTER_CUTOFF_LEVEL_COUNT -
          minimumVoltage) +
        0.5,
    );
  }
  return output;
}

function buildDacTable(bits: number, resistorRatio: number, terminated: boolean): Uint16Array {
  const bitVoltages = new Float64Array(bits);
  for (let setBit = 0; setBit < bits; setBit += 1) {
    let voltage = 1;
    const resistor = 1;
    const doubleResistor = resistorRatio * resistor;
    let tailResistance = terminated ? doubleResistor : Number.POSITIVE_INFINITY;
    let bit = 0;
    for (; bit < setBit; bit += 1) {
      tailResistance = Number.isFinite(tailResistance)
        ? resistor + (doubleResistor * tailResistance) / (doubleResistor + tailResistance)
        : resistor + doubleResistor;
    }
    if (Number.isFinite(tailResistance)) {
      tailResistance = (doubleResistor * tailResistance) / (doubleResistor + tailResistance);
      voltage = (voltage * tailResistance) / doubleResistor;
    } else {
      tailResistance = doubleResistor;
    }
    for (bit += 1; bit < bits; bit += 1) {
      tailResistance += resistor;
      const current = voltage / tailResistance;
      tailResistance = (doubleResistor * tailResistance) / (doubleResistor + tailResistance);
      voltage = tailResistance * current;
    }
    bitVoltages[setBit] = voltage;
  }

  const output = new Uint16Array(1 << bits);
  for (let value = 0; value < output.length; value += 1) {
    let remaining = value;
    let voltage = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      const bitVoltage = arrayValue(bitVoltages, bit, 'MOS 6581 DAC bit voltage');
      voltage += (remaining & 1) !== 0 ? bitVoltage : MOS6581_DAC_LEAKAGE * bitVoltage;
      remaining >>= 1;
    }
    output[value] = Math.trunc(((1 << bits) - 1) * voltage + 0.5);
  }
  return output;
}

function buildVcrGateVoltageTable(normalized16: number, minimumVoltage: number): Uint16Array {
  const output = new Uint16Array(NORMALIZED_VOLTAGE_LEVEL_COUNT);
  const normalizedMinimum = normalized16 * minimumVoltage;
  const normalizedThreshold =
    normalized16 * MOS6581_GATE_COUPLING * (MOS6581_SUPPLY_VOLTS - MOS6581_THRESHOLD_VOLTS);
  for (let index = 0; index < output.length; index += 1) {
    const gateVoltage = normalizedThreshold - Math.sqrt(index * NORMALIZED_VOLTAGE_LEVEL_COUNT);
    output[index] = Math.trunc(MOS6581_GATE_COUPLING * gateVoltage - normalizedMinimum + 0.5);
  }
  return output;
}

function buildVcrCurrentTable(normalized16: number): Uint16Array {
  const output = new Uint16Array(NORMALIZED_VOLTAGE_LEVEL_COUNT);
  const coupledThreshold = MOS6581_GATE_COUPLING * MOS6581_THRESHOLD_VOLTS;
  const saturationCurrent =
    ((2 * MOS6581_TRANSISTOR_UCOX * MOS6581_THERMAL_VOLTS ** 2) / MOS6581_GATE_COUPLING) *
    MOS6581_VCR_WIDTH_LENGTH_RATIO;
  const normalizedCurrent =
    (normalized16 / 2 / SID_FILTER_REFERENCE_CLOCK_HZ / MOS6581_CAPACITANCE_FARADS) *
    saturationCurrent;
  for (let voltage = 0; voltage < output.length; voltage += 1) {
    const logarithm = Math.log1p(
      Math.exp((voltage / normalized16 - coupledThreshold) / (2 * MOS6581_THERMAL_VOLTS)),
    );
    output[voltage] = Math.trunc(normalizedCurrent * logarithm * logarithm);
  }
  return output;
}

function summerOffset(inputCount: number): number {
  if (
    !Number.isInteger(inputCount) ||
    inputCount < 0 ||
    inputCount > FILTER_SUMMER_CONFIGURATION_COUNT
  ) {
    throw new RangeError(`MOS 6581 filter summer input count ${inputCount} is outside 0-5.`);
  }
  return ((inputCount * (inputCount + 3)) / 2) * NORMALIZED_VOLTAGE_LEVEL_COUNT;
}

function mixerOffset(inputCount: number): number {
  if (
    !Number.isInteger(inputCount) ||
    inputCount < 0 ||
    inputCount > AUDIO_MIXER_CONFIGURATION_COUNT
  ) {
    throw new RangeError(`MOS 6581 audio mixer input count ${inputCount} is outside 0-8.`);
  }
  if (inputCount === 0) return 0;
  return 1 + ((inputCount - 1) * inputCount * NORMALIZED_VOLTAGE_LEVEL_COUNT) / 2;
}

function lookupTable(table: Uint16Array, index: number, name: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= table.length) {
    throw new RangeError(`${name} index ${index} is outside 0-${table.length - 1}.`);
  }
  const value = table[index];
  if (value === undefined) throw new RangeError(`${name} index ${index} is not initialized.`);
  return value;
}

function arrayValue<T>(
  values: { readonly [index: number]: T; readonly length: number },
  index: number,
  name: string,
): T {
  if (!Number.isInteger(index) || index < 0 || index >= values.length) {
    throw new RangeError(`${name} index ${index} is outside 0-${values.length - 1}.`);
  }
  const value = values[index];
  if (value === undefined) throw new RangeError(`${name} index ${index} is not initialized.`);
  return value;
}

/** JavaScript 位运算会先截为 32 位；这里对安全整数执行与有符号算术右移相同的向下取整。 */
function arithmeticShiftRight(value: number, bits: number): number {
  return Math.floor(value / 2 ** bits);
}
