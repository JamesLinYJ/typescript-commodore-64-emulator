// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 波形查找表
//
//   文件:       SidWaveformTables.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import {
  SID_6581_PULSE_SAW_DATA,
  SID_6581_PULSE_SAW_TRIANGLE_DATA,
  SID_6581_PULSE_TRIANGLE_DATA,
  SID_6581_TRIANGLE_SAW_DATA,
  SID_8580_PULSE_SAW_DATA,
  SID_8580_PULSE_SAW_TRIANGLE_DATA,
  SID_8580_PULSE_TRIANGLE_DATA,
  SID_8580_TRIANGLE_SAW_DATA,
} from './SidCombinedWaveformData';
import { SID_MODEL, type SidModel } from './SidModel';

const WAVEFORM_SAMPLE_COUNT = 1 << 12;
const WAVEFORM_MAXIMUM = WAVEFORM_SAMPLE_COUNT - 1;
const COMBINED_SAMPLE_TO_TWELVE_BIT_SHIFT = 4;
const TRIANGLE_INDEX = 1;
const SAWTOOTH_INDEX = 2;
const TRIANGLE_SAW_INDEX = 3;
const PULSE_INDEX = 4;
const PULSE_TRIANGLE_INDEX = 5;
const PULSE_SAW_INDEX = 6;
const PULSE_SAW_TRIANGLE_INDEX = 7;

type SidWaveformTable = Uint16Array<ArrayBufferLike>;
type SidWaveformTableSet = readonly SidWaveformTable[];

function decodeCombinedSamples(encoded: string, description: string): SidWaveformTable {
  let binary: string;
  try {
    binary = atob(encoded);
  } catch (error: unknown) {
    throw new Error(`SID ${description} waveform data is not valid Base64.`, { cause: error });
  }
  if (binary.length !== WAVEFORM_SAMPLE_COUNT) {
    throw new RangeError(
      `SID ${description} waveform table has ${binary.length} samples; expected ${WAVEFORM_SAMPLE_COUNT}.`,
    );
  }

  const table = new Uint16Array(WAVEFORM_SAMPLE_COUNT);
  for (let index = 0; index < binary.length; index += 1) {
    table[index] = binary.charCodeAt(index) << COMBINED_SAMPLE_TO_TWELVE_BIT_SHIFT;
  }
  return table;
}

function buildWaveformTables(
  model: SidModel,
  combinedData: readonly [string, string, string, string],
): SidWaveformTableSet {
  const tables: SidWaveformTable[] = Array.from(
    { length: 8 },
    () => new Uint16Array(WAVEFORM_SAMPLE_COUNT),
  );
  const noWaveform = tables[0];
  const triangle = tables[TRIANGLE_INDEX];
  const sawtooth = tables[SAWTOOTH_INDEX];
  const pulse = tables[PULSE_INDEX];
  if (!noWaveform || !triangle || !sawtooth || !pulse) {
    throw new Error(`SID ${model} base waveform table allocation failed.`);
  }

  noWaveform.fill(WAVEFORM_MAXIMUM);
  pulse.fill(WAVEFORM_MAXIMUM);
  for (let phase = 0; phase < WAVEFORM_SAMPLE_COUNT; phase += 1) {
    const accumulator = phase << 12;
    const invertedPhaseMask = (accumulator & 0x80_0000) !== 0 ? -1 : 0;
    triangle[phase] = ((accumulator ^ invertedPhaseMask) >> 11) & 0x0ffe;
    sawtooth[phase] = phase;
  }

  tables[TRIANGLE_SAW_INDEX] = decodeCombinedSamples(combinedData[0], `${model} triangle+saw`);
  tables[PULSE_TRIANGLE_INDEX] = decodeCombinedSamples(combinedData[1], `${model} pulse+triangle`);
  tables[PULSE_SAW_INDEX] = decodeCombinedSamples(combinedData[2], `${model} pulse+saw`);
  tables[PULSE_SAW_TRIANGLE_INDEX] = decodeCombinedSamples(
    combinedData[3],
    `${model} pulse+saw+triangle`,
  );
  return tables;
}

const SID_6581_WAVEFORM_TABLES = buildWaveformTables(SID_MODEL.mos6581, [
  SID_6581_TRIANGLE_SAW_DATA,
  SID_6581_PULSE_TRIANGLE_DATA,
  SID_6581_PULSE_SAW_DATA,
  SID_6581_PULSE_SAW_TRIANGLE_DATA,
]);

const SID_8580_WAVEFORM_TABLES = buildWaveformTables(SID_MODEL.mos8580, [
  SID_8580_TRIANGLE_SAW_DATA,
  SID_8580_PULSE_TRIANGLE_DATA,
  SID_8580_PULSE_SAW_DATA,
  SID_8580_PULSE_SAW_TRIANGLE_DATA,
]);

export function sidWaveformTable(model: SidModel, waveformIndex: number): SidWaveformTable {
  const tables = model === SID_MODEL.mos6581 ? SID_6581_WAVEFORM_TABLES : SID_8580_WAVEFORM_TABLES;
  const table = tables[waveformIndex];
  if (!table) {
    throw new RangeError(`SID waveform index is outside 0-7: ${waveformIndex}.`);
  }
  return table;
}
