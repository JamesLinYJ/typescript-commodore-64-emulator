// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6526 串行移位寄存器测试
//
//   文件:       Mos6526SerialPort.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { Mos6526SerialPort } from '../../src/devices/Mos6526SerialPort';

const SERIAL_HALF_BITS_PER_BYTE = 16;

function loadOutputRegister(serial: Mos6526SerialPort, value: number): void {
  serial.writeOutputByte(value);
  expect(serial.outputActive).toBe(false);
  expect(serial.tickCycle()).toBe(false);
  expect(serial.outputActive).toBe(false);
  expect(serial.tickCycle()).toBe(false);
  expect(serial.outputActive).toBe(true);
}

describe('Mos6526SerialPort', () => {
  it('uses two Timer A underflows per output bit and shifts the most-significant bit first', () => {
    const serial = new Mos6526SerialPort();
    loadOutputRegister(serial, 0xa5);
    const outputBits: number[] = [];

    for (let bit = 0; bit < 8; bit += 1) {
      outputBits.push(serial.dataOutputHigh ? 1 : 0);
      expect(serial.clockOutputHalfBit()).toBe(false);
      expect(serial.clockOutputHigh).toBe(false);
      expect(serial.clockOutputHalfBit()).toBe(bit === 7);
      expect(serial.clockOutputHigh).toBe(true);
    }

    expect(outputBits).toEqual([1, 0, 1, 0, 0, 1, 0, 1]);
    expect(serial.outputActive).toBe(false);
    expect(serial.dataOutputHigh).toBe(true);
  });

  it('reports no completion before all sixteen half-bit clocks', () => {
    const serial = new Mos6526SerialPort();
    loadOutputRegister(serial, 0x55);

    for (let halfBit = 1; halfBit < SERIAL_HALF_BITS_PER_BYTE; halfBit += 1) {
      expect(serial.clockOutputHalfBit()).toBe(false);
    }
    expect(serial.outputActive).toBe(true);
    expect(serial.tickCycle()).toBe(false);
    expect(serial.tickCycle()).toBe(true);
    expect(serial.clockOutputHalfBit()).toBe(true);
    expect(serial.outputActive).toBe(false);
  });

  it('delays a Timer A output clock transition by two chip cycles', () => {
    const serial = new Mos6526SerialPort();
    loadOutputRegister(serial, 0x80);

    serial.scheduleOutputClockTransition();
    expect(serial.tickCycle()).toBe(false);
    expect(serial.clockOutputHigh).toBe(true);
    expect(serial.tickCycle()).toBe(false);
    expect(serial.clockOutputHigh).toBe(false);
  });

  it('keeps a second SDR write queued for a continuous back-to-back transfer', () => {
    const serial = new Mos6526SerialPort();
    loadOutputRegister(serial, 0xa5);
    serial.writeOutputByte(0x3c);
    serial.tickCycle();
    serial.tickCycle();

    for (let halfBit = 1; halfBit < SERIAL_HALF_BITS_PER_BYTE; halfBit += 1) {
      expect(serial.clockOutputHalfBit()).toBe(false);
    }
    expect(serial.clockOutputHalfBit()).toBe(true);
    expect(serial.outputActive).toBe(true);
    expect(serial.dataOutputHigh).toBe(false);

    for (let halfBit = 1; halfBit < SERIAL_HALF_BITS_PER_BYTE; halfBit += 1) {
      expect(serial.clockOutputHalfBit()).toBe(false);
    }
    expect(serial.clockOutputHalfBit()).toBe(true);
    expect(serial.outputActive).toBe(false);
  });

  it('keeps two following SDR bytes when the first is loaded after the empty flag', () => {
    const serial = new Mos6526SerialPort();
    loadOutputRegister(serial, 0x00);

    for (let halfBit = 1; halfBit < SERIAL_HALF_BITS_PER_BYTE; halfBit += 1) {
      serial.clockOutputHalfBit();
    }

    serial.writeOutputByte(0xaa);
    serial.tickCycle();
    serial.tickCycle();
    serial.writeOutputByte(0x55);
    serial.tickCycle();
    serial.tickCycle();

    expect(serial.clockOutputHalfBit()).toBe(true);
    const outputBits: number[] = [];
    for (let bit = 0; bit < 16; bit += 1) {
      outputBits.push(serial.dataOutputHigh ? 1 : 0);
      serial.clockOutputHalfBit();
      serial.clockOutputHalfBit();
    }

    expect(outputBits).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1]);
    expect(serial.outputActive).toBe(false);
  });

  it('assembles input bits on external CNT rising edges', () => {
    const serial = new Mos6526SerialPort();
    const bits = [1, 1, 0, 0, 0, 0, 1, 1] as const;

    for (let index = 0; index < bits.length; index += 1) {
      const result = serial.clockInputBit(bits[index] === 1);
      expect(result.completed).toBe(index === bits.length - 1);
      if (result.completed) expect(result.value).toBe(0xc3);
    }
  });
});
