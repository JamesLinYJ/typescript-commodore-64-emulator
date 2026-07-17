// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - SID 芯片协调器
//
//   文件:       Sid.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Float32RingBuffer } from '../shared/Float32RingBuffer';
import { byte } from '../shared/numbers';
import { IoDevice } from './IoDevice';
import { SidAudioResampler } from './SidAudioResampler';
import { SidExternalFilter } from './SidExternalFilter';
import { SidFilter } from './SidFilter';
import { SID_MODEL, type SidModel } from './SidModel';
import {
  SID_MASK,
  SID_REGISTER,
  SID_REGISTER_COUNT,
  SID_TIMING,
  SID_VOICE_COUNT,
  SID_VOICE_REGISTER,
  SID_VOICE_REGISTER_COUNT,
} from './sidRegisters';
import { SidVoice } from './SidVoice';

export interface SidVoiceState {
  readonly attackDecay: number;
  readonly control: number;
  readonly envelope: number;
  readonly frequency: number;
  readonly pulseWidth: number;
  readonly sustainRelease: number;
}

export interface SidOptions {
  readonly model?: SidModel;
  readonly processorClockHz?: number;
  readonly sampleRateHz?: number;
}

interface PendingSidWrite {
  readonly index: number;
  readonly value: number;
}

export class Sid extends IoDevice {
  readonly voices: readonly [SidVoice, SidVoice, SidVoice];

  readonly model: SidModel;
  readonly processorClockHz: number;
  readonly sampleRateHz: number;

  private readonly filter: SidFilter;
  private readonly externalFilter: SidExternalFilter;
  private readonly resampler: SidAudioResampler;
  private readonly samples = new Float32RingBuffer(SID_TIMING.sampleBufferCapacity);
  private busLatch = 0;
  private busLatchCyclesRemaining = 0;
  private pendingWrite: PendingSidWrite | undefined;
  private paddleX = 0xff;
  private paddleY = 0xff;

  constructor(debug = false, options: SidOptions = {}) {
    super('SID', SID_REGISTER_COUNT, debug);
    this.model = options.model ?? SID_MODEL.mos6581;
    this.processorClockHz = options.processorClockHz ?? SID_TIMING.processorClockHz;
    this.sampleRateHz = options.sampleRateHz ?? SID_TIMING.sampleRateHz;
    if (this.processorClockHz <= 0 || this.sampleRateHz <= 0) {
      throw new RangeError('SID clock and sample rates must be positive.');
    }
    this.voices = [new SidVoice(this.model), new SidVoice(this.model), new SidVoice(this.model)];
    this.voices[0].setSyncSource(this.voices[2]);
    this.voices[1].setSyncSource(this.voices[0]);
    this.voices[2].setSyncSource(this.voices[1]);
    this.filter = new SidFilter(this.model, this.processorClockHz);
    this.externalFilter = new SidExternalFilter(this.processorClockHz);
    this.resampler = new SidAudioResampler(this.processorClockHz, this.sampleRateHz);
    this.installRegisterMap();
    this.reset();
  }

  get masterVolume(): number {
    return (this.registers[SID_REGISTER.filterModeVolume] ?? 0) & SID_MASK.volume;
  }

  get filterCutoff(): number {
    return this.filter.cutoff;
  }

  get pendingSampleCount(): number {
    return this.samples.size;
  }

  getVoice(voice: 0 | 1 | 2): SidVoiceState {
    const state = this.voices[voice];
    return {
      frequency: state.frequency,
      pulseWidth: state.pulseWidth,
      control: state.control,
      attackDecay: state.attackDecay,
      sustainRelease: state.sustainRelease,
      envelope: state.envelopeOutput,
    };
  }

  reset(): void {
    this.registers.fill(0);
    for (const voice of this.voices) voice.reset();
    this.filter.reset();
    this.externalFilter.reset();
    this.resampler.reset();
    this.samples.clear();
    this.busLatch = 0;
    this.busLatchCyclesRemaining = 0;
    this.pendingWrite = undefined;
    this.paddleX = 0xff;
    this.paddleY = 0xff;
  }

  tick(cycles: number): void {
    const elapsedCycles = Math.max(0, Math.trunc(cycles));
    for (let cycle = 0; cycle < elapsedCycles; cycle += 1) {
      for (let index = 0; index < SID_VOICE_COUNT; index += 1) {
        const voice = this.voiceAt(index);
        voice.clockEnvelope();
      }
      for (let index = 0; index < SID_VOICE_COUNT; index += 1) {
        this.voiceAt(index).clockOscillator();
      }
      for (let index = 0; index < SID_VOICE_COUNT; index += 1) {
        this.voiceAt(index).synchronizeOscillator();
      }
      for (let index = 0; index < SID_VOICE_COUNT; index += 1) {
        this.voiceAt(index).updateWaveformOutput();
      }

      const sample = this.resampler.push(this.clockAudioPath());
      if (sample !== undefined) this.samples.push(sample);
      this.commitPendingWrite();
      if (this.busLatchCyclesRemaining > 0) this.busLatchCyclesRemaining -= 1;
    }
  }

  drainSamples(maximumLength?: number): Float32Array {
    return maximumLength === undefined ? this.samples.drain() : this.samples.drain(maximumLength);
  }

  setPaddleInputs(x: number, y: number): void {
    this.paddleX = byte(x);
    this.paddleY = byte(y);
  }

  private installRegisterMap(): void {
    for (let index = 0; index < SID_REGISTER_COUNT; index += 1) {
      this.mapRegister(index, {
        read: () => this.readBusLatch(),
        write: (register, value) => this.writeSidRegister(register, value),
      });
    }
    this.mapRegister(SID_REGISTER.paddleX, {
      read: () => this.readDrivenValue(this.paddleX),
      write: (index, value) => this.writeSidRegister(index, value),
    });
    this.mapRegister(SID_REGISTER.paddleY, {
      read: () => this.readDrivenValue(this.paddleY),
      write: (index, value) => this.writeSidRegister(index, value),
    });
    this.mapRegister(SID_REGISTER.oscillator3, {
      read: () => this.readDrivenValue(this.readOscillator3()),
      write: (index, value) => this.writeSidRegister(index, value),
    });
    this.mapRegister(SID_REGISTER.envelope3, {
      read: () => this.readDrivenValue(this.voices[2].envelopeReadback),
      write: (index, value) => this.writeSidRegister(index, value),
    });
  }

  private writeSidRegister(index: number, value: number): void {
    this.latchBus(value);
    if (this.model === SID_MODEL.mos8580) {
      if (this.pendingWrite !== undefined) {
        throw new Error(
          `MOS 8580 write pipeline already contains register $${this.pendingWrite.index.toString(16).padStart(2, '0')}.`,
        );
      }
      this.pendingWrite = { index, value: byte(value) };
      return;
    }
    this.applySidRegisterWrite(index, value);
  }

  private applySidRegisterWrite(index: number, value: number): void {
    if (index >= SID_REGISTER.paddleX) return;
    this.registers[index] = value;

    if (index < SID_VOICE_COUNT * SID_VOICE_REGISTER_COUNT) {
      this.updateVoiceRegister(index);
      return;
    }
    this.updateFilterRegisters();
  }

  private commitPendingWrite(): void {
    const pending = this.pendingWrite;
    if (pending === undefined) return;
    this.pendingWrite = undefined;
    this.applySidRegisterWrite(pending.index, pending.value);
  }

  private updateVoiceRegister(index: number): void {
    const voiceIndex = Math.trunc(index / SID_VOICE_REGISTER_COUNT);
    const voice = this.voiceAt(voiceIndex);
    const register = index % SID_VOICE_REGISTER_COUNT;
    const base = voiceIndex * SID_VOICE_REGISTER_COUNT;
    switch (register) {
      case SID_VOICE_REGISTER.frequencyLow:
      case SID_VOICE_REGISTER.frequencyHigh:
        voice.frequency =
          (this.registers[base + SID_VOICE_REGISTER.frequencyLow] ?? 0) |
          ((this.registers[base + SID_VOICE_REGISTER.frequencyHigh] ?? 0) << 8);
        break;
      case SID_VOICE_REGISTER.pulseWidthLow:
      case SID_VOICE_REGISTER.pulseWidthHigh:
        voice.pulseWidth =
          ((this.registers[base + SID_VOICE_REGISTER.pulseWidthLow] ?? 0) |
            ((this.registers[base + SID_VOICE_REGISTER.pulseWidthHigh] ?? 0) << 8)) &
          SID_MASK.pulseWidth;
        break;
      case SID_VOICE_REGISTER.control:
        voice.setControl(this.registers[index] ?? 0);
        break;
      case SID_VOICE_REGISTER.attackDecay:
        voice.attackDecay = this.registers[index] ?? 0;
        break;
      case SID_VOICE_REGISTER.sustainRelease:
        voice.sustainRelease = this.registers[index] ?? 0;
        break;
    }
  }

  private updateFilterRegisters(): void {
    this.filter.cutoff =
      (((this.registers[SID_REGISTER.filterCutoffHigh] ?? 0) << 3) |
        ((this.registers[SID_REGISTER.filterCutoffLow] ?? 0) & 0x07)) &
      SID_MASK.filterCutoff;
    this.filter.resonanceRouting = this.registers[SID_REGISTER.filterResonanceRouting] ?? 0;
    this.filter.modeVolume = this.registers[SID_REGISTER.filterModeVolume] ?? 0;
  }

  private clockAudioPath(): number {
    const voiceSamples: [number, number, number] = [0, 0, 0];
    for (let index = 0; index < SID_VOICE_COUNT; index += 1) {
      voiceSamples[index] = this.voiceAt(index).analogOutput;
    }
    this.filter.clock(voiceSamples);
    return this.externalFilter.clock(this.filter.outputPcm) / 0x8000;
  }

  private readOscillator3(): number {
    return this.voices[2].readOscillator();
  }

  private latchBus(value: number): void {
    this.busLatch = byte(value);
    this.busLatchCyclesRemaining = SID_TIMING.busLatchDecayCycles[this.model];
  }

  private readBusLatch(): number {
    return this.busLatchCyclesRemaining > 0 ? this.busLatch : 0;
  }

  private readDrivenValue(value: number): number {
    this.latchBus(value);
    return byte(value);
  }

  private voiceAt(index: number): SidVoice {
    const voice = this.voices[index];
    if (!voice) throw new RangeError(`SID voice index ${index} is out of range.`);
    return voice;
  }
}
