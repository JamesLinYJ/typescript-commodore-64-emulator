// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Commodore 1530 Datasette 测试
//
//   文件:       Commodore1530Datasette.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  parseTapImage,
  TAP_IMAGE_LAYOUT,
  TAP_VIDEO_STANDARD,
} from '../../src/media/TapImageParser';
import { WritableTapImage } from '../../src/media/WritableTapImage';
import {
  Commodore1530Datasette,
  DATASETTE_TRANSPORT,
} from '../../src/peripherals/tape/Commodore1530Datasette';
import { C64TapePort } from '../../src/peripherals/tape/C64TapePort';

function createTap(data: readonly number[], video: number = TAP_VIDEO_STANDARD.pal): Uint8Array {
  const bytes = new Uint8Array(TAP_IMAGE_LAYOUT.headerSize + data.length);
  bytes.set(Uint8Array.from(TAP_IMAGE_LAYOUT.magic, (character) => character.charCodeAt(0)));
  bytes[TAP_IMAGE_LAYOUT.versionOffset] = 1;
  bytes[TAP_IMAGE_LAYOUT.systemOffset] = 0;
  bytes[TAP_IMAGE_LAYOUT.videoStandardOffset] = video;
  new DataView(bytes.buffer).setUint32(TAP_IMAGE_LAYOUT.dataLengthOffset, data.length, true);
  bytes.set(data, TAP_IMAGE_LAYOUT.headerSize);
  return bytes;
}

describe('Commodore1530Datasette', () => {
  it('closes SENSE on PLAY but advances pulses only while the host motor line is active', () => {
    const port = new C64TapePort();
    const datasette = new Commodore1530Datasette(port);
    datasette.insertTape(parseTapImage(createTap([2, 3])));
    const pulses: number[] = [];
    port.observeReadPulses(({ sequence }) => pulses.push(sequence));

    datasette.pressPlay();
    expect(port.senseSwitchClosed).toBe(true);
    datasette.tick(100);
    expect(datasette.pulseIndex).toBe(0);

    port.setHostSignals({ motorActive: true, writeHigh: true });
    datasette.tick(15);
    expect(pulses).toEqual([]);
    datasette.tick(1);
    expect(pulses).toEqual([1]);
    expect(datasette.pulseIndex).toBe(1);
    datasette.tick(24);
    expect(pulses).toEqual([1, 2]);
    expect(datasette.transport).toBe(DATASETTE_TRANSPORT.stopped);
    expect(port.senseSwitchClosed).toBe(false);
  });

  it('scales NTSC-captured pulse duration into the PAL target clock with integer arithmetic', () => {
    const port = new C64TapePort();
    const datasette = new Commodore1530Datasette(port);
    const ntscOneSecond = 1_022_730;
    datasette.insertTape(
      parseTapImage(
        createTap(
          [0, ntscOneSecond & 0xff, (ntscOneSecond >>> 8) & 0xff, (ntscOneSecond >>> 16) & 0xff],
          TAP_VIDEO_STANDARD.ntsc,
        ),
      ),
    );
    datasette.pressPlay();
    port.setHostSignals({ motorActive: true, writeHigh: true });

    datasette.tick(985_247);
    expect(datasette.pulseIndex).toBe(0);
    datasette.tick(1);
    expect(datasette.pulseIndex).toBe(1);
    expect(datasette.elapsedTargetCycles).toBe(985_248);
  });

  it('requires stopped, explicit media lifecycle operations', () => {
    const port = new C64TapePort();
    const datasette = new Commodore1530Datasette(port);
    const image = parseTapImage(createTap([1]));
    datasette.insertTape(image);
    datasette.pressPlay();
    expect(() => datasette.ejectTape()).toThrow(/Stop/);
    expect(() => datasette.rewindToStart()).toThrow(/Stop/);
    datasette.pressStop();
    datasette.seekPulse(1);
    expect(datasette.pulseIndex).toBe(1);
    datasette.rewindToStart();
    expect(datasette.pulseIndex).toBe(0);
    expect(datasette.ejectTape()).toBe(image);
    expect(() => datasette.ejectTape()).toThrow(/empty/);
  });

  it('records rising WRITE flux edges with deterministic TAP quantization and plays them back', () => {
    const port = new C64TapePort();
    const datasette = new Commodore1530Datasette(port);
    const image = new WritableTapImage();
    datasette.insertTape(image);
    datasette.pressRecord();
    expect(port.senseSwitchClosed).toBe(true);

    port.setHostSignals({ motorActive: true, writeHigh: true });
    datasette.tick(385);
    port.setHostSignals({ motorActive: true, writeHigh: false });
    expect(image.pulses).toEqual([]);
    port.setHostSignals({ motorActive: true, writeHigh: true });
    expect(image.pulses.map(({ sourceCycles }) => sourceCycles)).toEqual([384]);

    datasette.tick(527);
    port.setHostSignals({ motorActive: true, writeHigh: false });
    port.setHostSignals({ motorActive: true, writeHigh: true });
    expect(image.pulses.map(({ sourceCycles }) => sourceCycles)).toEqual([384, 528]);
    expect(datasette.pulseIndex).toBe(2);
    expect(datasette.elapsedTargetCycles).toBe(912);

    datasette.pressStop();
    const serialized = parseTapImage(image.toBytes());
    expect(serialized.pulses.map(({ sourceCycles }) => sourceCycles)).toEqual([384, 528]);

    const readPulses: number[] = [];
    port.observeReadPulses(({ sequence }) => readPulses.push(sequence));
    datasette.rewindToStart();
    datasette.pressPlay();
    datasette.tick(383);
    expect(readPulses).toEqual([]);
    datasette.tick(1);
    datasette.tick(528);
    expect(readPulses).toEqual([1, 2]);
    expect(datasette.transport).toBe(DATASETTE_TRANSPORT.stopped);
  });

  it('rejects RECORD for read-only media and overwrites writable media from its current position', () => {
    const port = new C64TapePort();
    const datasette = new Commodore1530Datasette(port);
    datasette.insertTape(parseTapImage(createTap([1])));
    expect(() => datasette.pressRecord()).toThrow(/write protected/);
    datasette.ejectTape();

    const writable = new WritableTapImage();
    writable.appendPulse(8);
    writable.appendPulse(16);
    datasette.insertTape(writable);
    datasette.seekPulse(1);
    datasette.pressRecord();
    expect(writable.pulses).toHaveLength(2);
    port.setHostSignals({ motorActive: true, writeHigh: false });
    expect(writable.pulses.map(({ sourceCycles }) => sourceCycles)).toEqual([8]);
    datasette.tick(24);
    port.setHostSignals({ motorActive: true, writeHigh: true });
    expect(writable.pulses.map(({ sourceCycles }) => sourceCycles)).toEqual([8, 24]);
  });

  it('keeps single-cycle playback exactly equivalent to tick(1)', () => {
    const batchedPort = new C64TapePort();
    const singleCyclePort = new C64TapePort();
    const batched = new Commodore1530Datasette(batchedPort);
    const singleCycle = new Commodore1530Datasette(singleCyclePort);
    batched.insertTape(parseTapImage(createTap([2, 3, 1])));
    singleCycle.insertTape(parseTapImage(createTap([2, 3, 1])));
    const batchedPulses: number[] = [];
    const singleCyclePulses: number[] = [];
    batchedPort.observeReadPulses(({ sequence }) => batchedPulses.push(sequence));
    singleCyclePort.observeReadPulses(({ sequence }) => singleCyclePulses.push(sequence));
    for (const datasette of [batched, singleCycle]) datasette.pressPlay();
    for (const port of [batchedPort, singleCyclePort]) {
      port.setHostSignals({ motorActive: true, writeHigh: true });
    }

    for (let cycle = 0; cycle < 64; cycle += 1) {
      batched.tick(1);
      singleCycle.clockCycle();
      expect(singleCycle.pulseIndex).toBe(batched.pulseIndex);
      expect(singleCycle.elapsedTargetCycles).toBe(batched.elapsedTargetCycles);
      expect(singleCycle.transport).toBe(batched.transport);
      expect(singleCyclePort.senseSwitchClosed).toBe(batchedPort.senseSwitchClosed);
      expect(singleCyclePulses).toEqual(batchedPulses);
    }
  });

  it('keeps single-cycle recording exactly equivalent to tick(1)', () => {
    const batchedPort = new C64TapePort();
    const singleCyclePort = new C64TapePort();
    const batchedImage = new WritableTapImage();
    const singleCycleImage = new WritableTapImage();
    const batched = new Commodore1530Datasette(batchedPort);
    const singleCycle = new Commodore1530Datasette(singleCyclePort);
    batched.insertTape(batchedImage);
    singleCycle.insertTape(singleCycleImage);
    batched.pressRecord();
    singleCycle.pressRecord();
    for (const port of [batchedPort, singleCyclePort]) {
      port.setHostSignals({ motorActive: true, writeHigh: false });
    }

    for (let cycle = 1; cycle <= 40; cycle += 1) {
      batched.tick(1);
      singleCycle.clockCycle();
      if (cycle === 9 || cycle === 25) {
        batchedPort.setHostSignals({ motorActive: true, writeHigh: true });
        singleCyclePort.setHostSignals({ motorActive: true, writeHigh: true });
        batchedPort.setHostSignals({ motorActive: true, writeHigh: false });
        singleCyclePort.setHostSignals({ motorActive: true, writeHigh: false });
      }
      expect(singleCycle.elapsedTargetCycles).toBe(batched.elapsedTargetCycles);
      expect(singleCycle.pulseIndex).toBe(batched.pulseIndex);
      expect(singleCycleImage.pulses).toEqual(batchedImage.pulses);
    }
  });
});
