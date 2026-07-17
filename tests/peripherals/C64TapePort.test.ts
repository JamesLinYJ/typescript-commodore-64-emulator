// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 磁带端口测试
//
//   文件:       C64TapePort.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { C64TapePort } from '../../src/peripherals/tape/C64TapePort';

describe('C64TapePort', () => {
  it('separates host output lines from device SENSE and READ lines', () => {
    const port = new C64TapePort();
    const device = port.attachDevice('test datasette');
    const hostTransitions: boolean[] = [];
    const senseTransitions: boolean[] = [];
    const readPulses: number[] = [];
    port.observeHostSignals(({ current }) => hostTransitions.push(current.motorActive));
    port.observeSenseSwitch(({ closed }) => senseTransitions.push(closed));
    port.observeReadPulses(({ sequence }) => readPulses.push(sequence));

    port.setHostSignals({ motorActive: true, writeHigh: false });
    device.setSenseSwitchClosed(true);
    device.pulseRead();
    device.pulseRead();

    expect(port.hostSignals).toEqual({ motorActive: true, writeHigh: false });
    expect(port.senseSwitchClosed).toBe(true);
    expect(hostTransitions).toEqual([true]);
    expect(senseTransitions).toEqual([true]);
    expect(readPulses).toEqual([1, 2]);
  });

  it('allows one physical device and rejects stale device connections after disconnect', () => {
    const port = new C64TapePort();
    const first = port.attachDevice('first');
    expect(() => port.attachDevice('second')).toThrow(/already has an attached device/);
    first.setSenseSwitchClosed(true);
    first.disconnect();
    expect(port.senseSwitchClosed).toBe(false);
    expect(() => first.pulseRead()).toThrow(/no longer attached/);

    const second = port.attachDevice('second');
    second.pulseRead();
    expect(port.deviceAttached).toBe(true);
  });
});
