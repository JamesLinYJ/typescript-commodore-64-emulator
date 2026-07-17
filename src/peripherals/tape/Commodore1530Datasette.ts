// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Commodore 1530 Datasette
//
//   文件:       Commodore1530Datasette.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { TapImage } from '../../media/TapImageParser';
import type { WritableTapImage } from '../../media/WritableTapImage';
import { PAL_VIDEO_STANDARD } from '../../video/palVideoStandard';
import {
  C64TapePort,
  type C64TapeDevicePort,
  type C64TapeHostSignalTransition,
} from './C64TapePort';

export const DATASETTE_TRANSPORT = {
  play: 'play',
  record: 'record',
  stopped: 'stopped',
} as const;

export type DatasetteTransport = (typeof DATASETTE_TRANSPORT)[keyof typeof DATASETTE_TRANSPORT];
export type DatasetteTapeImage = TapImage | WritableTapImage;

const TAP_SHORT_PULSE_CYCLE_QUANTUM = 8;
const TAP_EXTENDED_PULSE_THRESHOLD_CYCLES = 0xff * TAP_SHORT_PULSE_CYCLE_QUANTUM + 7;

/**
 * C1530 录放机构。播放时把 TAP 脉冲送入 READ，录音时测量 WRITE 磁通边沿；
 * SENSE、MOTOR 与 WRITE 始终经由物理磁带端口，介质层不接触 C64 内存或 CPU。
 */
export class Commodore1530Datasette {
  readonly tapePort: C64TapePort;

  private readonly devicePort: C64TapeDevicePort;
  private readonly stopObservingHostSignals: () => void;
  private tape: DatasetteTapeImage | undefined;
  private transportValue: DatasetteTransport = DATASETTE_TRANSPORT.stopped;
  private pulseIndexValue = 0;
  private pulseCyclesRemaining = 0;
  private scalingRemainder = 0;
  private elapsedTargetCyclesValue = 0;
  private recordCyclesSinceEdge = 0;
  private recordClockRemainder = 0;
  private recordQuantizationRemainder = 0;
  private connected = true;

  constructor(
    tapePort: C64TapePort,
    private readonly targetClockHz: number = PAL_VIDEO_STANDARD.timing.processorClockHz,
  ) {
    if (!Number.isSafeInteger(targetClockHz) || targetClockHz <= 0) {
      throw new RangeError('Datasette target clock must be a positive safe integer in hertz.');
    }
    this.tapePort = tapePort;
    this.devicePort = tapePort.attachDevice('Commodore 1530 Datasette');
    this.stopObservingHostSignals = tapePort.observeHostSignals((event) =>
      this.handleHostSignalTransition(event),
    );
  }

  get mountedTape(): DatasetteTapeImage | undefined {
    return this.tape;
  }

  get transport(): DatasetteTransport {
    return this.transportValue;
  }

  get pulseIndex(): number {
    return this.pulseIndexValue;
  }

  get elapsedTargetCycles(): number {
    return this.elapsedTargetCyclesValue;
  }

  get motorActive(): boolean {
    return this.tapePort.hostSignals.motorActive;
  }

  insertTape(image: DatasetteTapeImage): void {
    this.requireConnected();
    if (this.tape) throw new Error('A TAP image is already inserted in the Datasette.');
    if (this.transportValue !== DATASETTE_TRANSPORT.stopped) {
      throw new Error('Stop the Datasette before inserting a tape.');
    }
    this.tape = image;
    this.resetPosition();
  }

  ejectTape(): DatasetteTapeImage {
    this.requireConnected();
    if (this.transportValue !== DATASETTE_TRANSPORT.stopped) {
      throw new Error('Stop the Datasette before ejecting its tape.');
    }
    const image = this.tape;
    if (!image) throw new Error('Cannot eject because the Datasette is empty.');
    this.tape = undefined;
    this.resetPosition();
    return image;
  }

  pressPlay(): void {
    this.requireConnected();
    this.transportValue = DATASETTE_TRANSPORT.play;
    // PLAY/RECORD 键机械地闭合 SENSE；它与主机是否打开马达无关。
    this.devicePort.setSenseSwitchClosed(true);
  }

  pressRecord(): void {
    this.requireConnected();
    const image = this.tape;
    if (!image) throw new Error('Cannot record because the Datasette is empty.');
    if (!image.writable) throw new Error('The inserted TAP image is write protected.');
    if (this.transportValue !== DATASETTE_TRANSPORT.stopped) {
      throw new Error('Stop the Datasette before pressing RECORD.');
    }
    this.transportValue = DATASETTE_TRANSPORT.record;
    this.resetRecordingTiming();
    this.devicePort.setSenseSwitchClosed(true);
    if (this.motorActive) this.beginRecordingWindow();
  }

  pressStop(): void {
    this.requireConnected();
    this.stopTransport();
  }

  rewindToStart(): void {
    this.requireConnected();
    if (this.transportValue !== DATASETTE_TRANSPORT.stopped) {
      throw new Error('Stop the Datasette before rewinding.');
    }
    if (!this.tape) throw new Error('Cannot rewind because the Datasette is empty.');
    this.resetPosition();
  }

  seekPulse(pulseIndex: number): void {
    this.requireConnected();
    const image = this.tape;
    if (!image) throw new Error('Cannot seek because the Datasette is empty.');
    if (this.transportValue !== DATASETTE_TRANSPORT.stopped) {
      throw new Error('Stop the Datasette before seeking.');
    }
    if (!Number.isInteger(pulseIndex) || pulseIndex < 0 || pulseIndex > image.pulses.length) {
      throw new RangeError(`Datasette pulse index must be from 0 through ${image.pulses.length}.`);
    }
    this.pulseIndexValue = pulseIndex;
    this.pulseCyclesRemaining = 0;
    this.scalingRemainder = 0;
    this.elapsedTargetCyclesValue = 0;
    this.resetRecordingTiming();
  }

  tick(cycles: number): void {
    if (!Number.isSafeInteger(cycles) || cycles < 0) {
      throw new RangeError('Datasette cycles must be a non-negative safe integer.');
    }
    const image = this.tape;
    if (cycles === 0 || !image || !this.motorActive) return;

    if (this.transportValue === DATASETTE_TRANSPORT.record) {
      this.recordCyclesSinceEdge += cycles;
      this.elapsedTargetCyclesValue += cycles;
      if (
        !Number.isSafeInteger(this.recordCyclesSinceEdge) ||
        !Number.isSafeInteger(this.elapsedTargetCyclesValue)
      ) {
        throw new RangeError(
          'Datasette recording duration exceeds exact JavaScript integer range.',
        );
      }
      return;
    }
    if (this.transportValue !== DATASETTE_TRANSPORT.play) return;

    let availableCycles = cycles;
    while (availableCycles > 0) {
      if (this.pulseIndexValue >= image.pulses.length) {
        this.stopTransport();
        return;
      }
      if (this.pulseCyclesRemaining === 0) this.loadCurrentPulseDuration(image);

      const consumed = Math.min(availableCycles, this.pulseCyclesRemaining);
      this.pulseCyclesRemaining -= consumed;
      availableCycles -= consumed;
      this.elapsedTargetCyclesValue += consumed;
      if (this.pulseCyclesRemaining !== 0) continue;

      this.pulseIndexValue += 1;
      this.devicePort.pulseRead();
      if (this.pulseIndexValue >= image.pulses.length) this.stopTransport();
    }
  }

  disconnect(): void {
    this.requireConnected();
    this.stopTransport();
    this.stopObservingHostSignals();
    this.devicePort.disconnect();
    this.connected = false;
  }

  private loadCurrentPulseDuration(image: DatasetteTapeImage): void {
    const pulse = image.pulses[this.pulseIndexValue];
    if (!pulse) throw new RangeError(`TAP pulse ${this.pulseIndexValue} is missing.`);
    const numerator = pulse.sourceCycles * this.targetClockHz + this.scalingRemainder;
    if (!Number.isSafeInteger(numerator)) {
      throw new RangeError('TAP pulse is too long for exact clock conversion.');
    }
    this.pulseCyclesRemaining = Math.floor(numerator / image.sourceClockHz);
    this.scalingRemainder = numerator % image.sourceClockHz;
    if (this.pulseCyclesRemaining <= 0) {
      throw new RangeError(`TAP pulse ${this.pulseIndexValue} is shorter than one target cycle.`);
    }
  }

  private resetPosition(): void {
    this.pulseIndexValue = 0;
    this.pulseCyclesRemaining = 0;
    this.scalingRemainder = 0;
    this.elapsedTargetCyclesValue = 0;
    this.resetRecordingTiming();
  }

  private stopTransport(): void {
    this.transportValue = DATASETTE_TRANSPORT.stopped;
    this.resetRecordingTiming();
    this.devicePort.setSenseSwitchClosed(false);
  }

  private handleHostSignalTransition(event: C64TapeHostSignalTransition): void {
    if (this.transportValue !== DATASETTE_TRANSPORT.record) return;

    if (!event.previous.motorActive && event.current.motorActive) this.beginRecordingWindow();
    else if (event.previous.motorActive && !event.current.motorActive) this.resetRecordingTiming();

    if (event.current.motorActive && !event.previous.writeHigh && event.current.writeHigh) {
      this.recordFluxTransition();
    }
  }

  private beginRecordingWindow(): void {
    const image = this.tape;
    if (!image?.writable) {
      throw new Error('Datasette RECORD transport lost its writable TAP image.');
    }
    // TAP 只能在脉冲边界定位；马达真正启动时才擦除当前位置之后的旧磁通记录。
    image.truncateAtPulse(this.pulseIndexValue);
    this.recordCyclesSinceEdge = 0;
    this.recordClockRemainder = 0;
    this.recordQuantizationRemainder = 0;
  }

  private recordFluxTransition(): void {
    const image = this.tape;
    if (!image?.writable) {
      throw new Error('Datasette RECORD transport lost its writable TAP image.');
    }

    const numerator = this.recordCyclesSinceEdge * image.sourceClockHz + this.recordClockRemainder;
    if (!Number.isSafeInteger(numerator)) {
      throw new RangeError('Recorded TAP pulse is too long for exact clock conversion.');
    }
    const convertedCycles = Math.floor(numerator / this.targetClockHz);
    this.recordClockRemainder = numerator % this.targetClockHz;
    this.recordCyclesSinceEdge = 0;

    const accumulatedCycles = convertedCycles + this.recordQuantizationRemainder;
    if (accumulatedCycles <= 0) return;

    let encodedCycles: number;
    if (accumulatedCycles < TAP_EXTENDED_PULSE_THRESHOLD_CYCLES) {
      const encodedUnits = Math.floor(accumulatedCycles / TAP_SHORT_PULSE_CYCLE_QUANTUM);
      if (encodedUnits === 0) {
        this.recordQuantizationRemainder = accumulatedCycles;
        return;
      }
      encodedCycles = encodedUnits * TAP_SHORT_PULSE_CYCLE_QUANTUM;
      this.recordQuantizationRemainder = accumulatedCycles % TAP_SHORT_PULSE_CYCLE_QUANTUM;
    } else {
      encodedCycles = accumulatedCycles;
      this.recordQuantizationRemainder = 0;
    }

    image.appendPulse(encodedCycles);
    this.pulseIndexValue = image.pulses.length;
  }

  private resetRecordingTiming(): void {
    this.recordCyclesSinceEdge = 0;
    this.recordClockRemainder = 0;
    this.recordQuantizationRemainder = 0;
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error('Commodore 1530 Datasette is disconnected.');
  }
}
