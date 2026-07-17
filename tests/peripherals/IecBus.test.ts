// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - IEC 开集电极总线测试
//
//   文件:       IecBus.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { IecBus, IEC_LINE, type IecBusTransition } from '../../src/peripherals/iec/IecBus';

describe('IecBus', () => {
  it('keeps every undriven line high through its physical pull-up resistor', () => {
    const bus = new IecBus();

    expect(bus.state).toEqual({
      attentionHigh: true,
      clockHigh: true,
      dataHigh: true,
      resetHigh: true,
      serviceRequestHigh: true,
    });
  });

  it('combines all drivers so one device cannot release a line held low by another', () => {
    const bus = new IecBus();
    const computer = bus.attach('C64');
    const drive = bus.attach('1541 #8');

    computer.setPulledLow(IEC_LINE.data, true);
    drive.setPulledLow(IEC_LINE.data, true);
    computer.setPulledLow(IEC_LINE.data, false);
    expect(bus.lineHigh(IEC_LINE.data)).toBe(false);

    drive.setPulledLow(IEC_LINE.data, false);
    expect(bus.lineHigh(IEC_LINE.data)).toBe(true);
  });

  it('publishes one atomic transition when a port changes several lines together', () => {
    const bus = new IecBus();
    const computer = bus.attach('C64');
    const transitions: IecBusTransition[] = [];
    bus.observe((transition) => transitions.push(transition));

    computer.setPulledLowLines([IEC_LINE.attention, IEC_LINE.clock, IEC_LINE.data]);

    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.sequence).toBe(1);
    expect(transitions[0]?.changedLines).toEqual([
      IEC_LINE.attention,
      IEC_LINE.clock,
      IEC_LINE.data,
    ]);
    expect(transitions[0]?.state).toMatchObject({
      attentionHigh: false,
      clockHigh: false,
      dataHigh: false,
    });
  });

  it('releases driven lines on disconnect and rejects stale port access', () => {
    const bus = new IecBus();
    const drive = bus.attach('1541 #8');
    drive.setPulledLow(IEC_LINE.clock, true);

    drive.disconnect();

    expect(bus.lineHigh(IEC_LINE.clock)).toBe(true);
    expect(() => drive.lineHigh(IEC_LINE.clock)).toThrow(/has been disconnected/);
    expect(() => drive.releaseAll()).toThrow(/has been disconnected/);
    expect(() => bus.attach('1541 #8')).not.toThrow();
  });

  it('rejects ambiguous duplicate device names', () => {
    const bus = new IecBus();
    bus.attach('1541 #8');

    expect(() => bus.attach('1541 #8')).toThrow(/already attached/);
  });
});
