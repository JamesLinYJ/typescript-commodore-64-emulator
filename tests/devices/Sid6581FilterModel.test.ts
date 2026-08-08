import { describe, expect, it } from 'vitest';

import {
  getSid6581FilterModel,
  type Sid6581IntegratorState,
} from '../../src/devices/Sid6581FilterModel';

const NORMALIZED_VOLTAGE_MAXIMUM = 0xffff;
const FILTER_CUTOFF_MAXIMUM = 0x07ff;
const RANDOM_LOOKUP_CASES = 4_096;
const RANDOM_INTEGRATOR_CYCLES = 100_000;

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function assertObjectIs(label: string, checked: number, unchecked: number): void {
  if (!Object.is(checked, unchecked)) {
    throw new Error(`${label}: checked=${checked}, unchecked=${unchecked}.`);
  }
}

function assertIntegratorState(
  cycle: number,
  checked: Sid6581IntegratorState,
  unchecked: Sid6581IntegratorState,
): void {
  assertObjectIs(`cycle ${cycle} capacitor`, checked.capacitorVoltage, unchecked.capacitorVoltage);
  assertObjectIs(`cycle ${cycle} op amp`, checked.opAmpInput, unchecked.opAmpInput);
}

describe('Sid6581FilterModel internal cycle lookups', () => {
  it('matches checked lookup APIs at every supported boundary and for fixed random inputs', () => {
    const model = getSid6581FilterModel();

    for (let resonance = 0; resonance <= 0x0f; resonance += 1) {
      for (const voltage of [0, NORMALIZED_VOLTAGE_MAXIMUM]) {
        assertObjectIs(
          `resonance ${resonance}, voltage ${voltage}`,
          model.resonanceGain(resonance, voltage),
          model.resonanceGainUnchecked(resonance, voltage),
        );
      }
    }
    for (let inputCount = 0; inputCount <= 4; inputCount += 1) {
      for (const voltageSum of [0, (inputCount + 2) * NORMALIZED_VOLTAGE_MAXIMUM]) {
        assertObjectIs(
          `summer ${inputCount}, sum ${voltageSum}`,
          model.sumFilterInputs(inputCount, voltageSum),
          model.sumFilterInputsUnchecked(inputCount, voltageSum),
        );
      }
    }
    for (let inputCount = 0; inputCount <= 7; inputCount += 1) {
      for (const voltageSum of [0, inputCount * NORMALIZED_VOLTAGE_MAXIMUM]) {
        assertObjectIs(
          `mixer ${inputCount}, sum ${voltageSum}`,
          model.mixAudioInputs(inputCount, voltageSum),
          model.mixAudioInputsUnchecked(inputCount, voltageSum),
        );
      }
    }
    for (let volume = 0; volume <= 0x0f; volume += 1) {
      for (const voltage of [0, NORMALIZED_VOLTAGE_MAXIMUM]) {
        assertObjectIs(
          `volume ${volume}, voltage ${voltage}`,
          model.applyVolume(volume, voltage),
          model.applyVolumeUnchecked(volume, voltage),
        );
      }
    }

    const random = createRandom(0xc64_6581);
    for (let sample = 0; sample < RANDOM_LOOKUP_CASES; sample += 1) {
      const resonance = random() & 0x0f;
      const resonanceVoltage = random() & NORMALIZED_VOLTAGE_MAXIMUM;
      assertObjectIs(
        `random resonance ${sample}`,
        model.resonanceGain(resonance, resonanceVoltage),
        model.resonanceGainUnchecked(resonance, resonanceVoltage),
      );

      const routedInputCount = random() % 5;
      const summerMaximum = (routedInputCount + 2) * NORMALIZED_VOLTAGE_MAXIMUM;
      const summerVoltage = random() % (summerMaximum + 1);
      assertObjectIs(
        `random summer ${sample}`,
        model.sumFilterInputs(routedInputCount, summerVoltage),
        model.sumFilterInputsUnchecked(routedInputCount, summerVoltage),
      );

      const mixerInputCount = random() % 8;
      const mixerMaximum = mixerInputCount * NORMALIZED_VOLTAGE_MAXIMUM;
      const mixerVoltage = mixerMaximum === 0 ? 0 : random() % (mixerMaximum + 1);
      assertObjectIs(
        `random mixer ${sample}`,
        model.mixAudioInputs(mixerInputCount, mixerVoltage),
        model.mixAudioInputsUnchecked(mixerInputCount, mixerVoltage),
      );

      const volume = random() & 0x0f;
      const mixedVoltage = random() & NORMALIZED_VOLTAGE_MAXIMUM;
      assertObjectIs(
        `random volume ${sample}`,
        model.applyVolume(volume, mixedVoltage),
        model.applyVolumeUnchecked(volume, mixedVoltage),
      );
    }
  });

  it('keeps checked and internal integrator state Object.is-identical for 100,000 cycles', () => {
    const model = getSid6581FilterModel();
    const checkedState = model.createIntegratorState();
    const uncheckedState = model.createIntegratorState();
    const random = createRandom(0x6581_c64);

    for (let cycle = 0; cycle < RANDOM_INTEGRATOR_CYCLES; cycle += 1) {
      const inputVoltage = random() % 61_899;
      const cutoffVoltageSquared = model.cutoffControlVoltageSquared(
        random() & FILTER_CUTOFF_MAXIMUM,
      );
      const checked = model.integrate(inputVoltage, checkedState, cutoffVoltageSquared);
      const unchecked = model.integrateUnchecked(
        inputVoltage,
        uncheckedState,
        cutoffVoltageSquared,
      );
      assertObjectIs(`cycle ${cycle} output`, checked, unchecked);
      assertIntegratorState(cycle, checkedState, uncheckedState);
    }
  });

  it('rejects an invalid cutoff without modifying public integrator state', () => {
    const model = getSid6581FilterModel();
    const state = model.createIntegratorState();
    state.capacitorVoltage = -123_456;
    state.opAmpInput = 22_222;
    const before = { ...state };

    expect(() => model.integrate(0, state, 2 ** 32)).toThrow(RangeError);
    expect(Object.is(state.capacitorVoltage, before.capacitorVoltage)).toBe(true);
    expect(Object.is(state.opAmpInput, before.opAmpInput)).toBe(true);
  });
});
