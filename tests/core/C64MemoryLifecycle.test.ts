// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 整机资源生命周期测试
//
//   文件:       C64MemoryLifecycle.test.ts
//
//   日期:       2026年08月10日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { C64Memory } from '../../src/core/memory/C64Memory';
import { Cia1 } from '../../src/devices/Cia1';
import { IecBus, IEC_LINE } from '../../src/peripherals/iec/IecBus';
import { createTestFirmware } from '../helpers/createTestSystem';

describe('C64 memory lifecycle', () => {
  it('releases shared IEC observers and ports before a second machine is mounted', () => {
    const iecBus = new IecBus();
    const first = new C64Memory(createTestFirmware(), { iecBus });
    first.dispose();

    // CIA2 使用固定设备名；第二个实例能连接，证明第一个主机端口已经真正 detach。
    const second = new C64Memory(createTestFirmware(), { iecBus });
    const probe = iecBus.attach('lifecycle probe');
    probe.setPulledLow(IEC_LINE.attention, true);

    expect(second.userPort.hostSignals.attentionHigh).toBe(false);
    expect(first.userPort.hostSignals.attentionHigh).toBe(true);
    expect(() => first.datasette.pressPlay()).toThrow(/disconnected/);

    second.dispose();
    probe.disconnect();
    expect(iecBus.state).toEqual({
      attentionHigh: true,
      clockHigh: true,
      dataHigh: true,
      resetHigh: true,
      serviceRequestHigh: true,
    });
  });

  it('allows idempotent teardown at an aborted or repeated owner boundary', () => {
    const memory = new C64Memory(createTestFirmware());

    memory.dispose();
    expect(() => memory.dispose()).not.toThrow();
  });

  it('detaches CIA1 callbacks from input objects that may outlive the machine', () => {
    const lightPenLevels: boolean[] = [];
    const cia1 = new Cia1({
      lightPenInput: { setLightPenInputHigh: (high) => lightPenLevels.push(high) },
    });
    const callsBeforeDisconnect = lightPenLevels.length;

    cia1.disconnect();
    expect(cia1.keyboard.setKeyState('Space', true)).toBe(true);
    expect(lightPenLevels).toHaveLength(callsBeforeDisconnect);
    expect(() => cia1.disconnect()).not.toThrow();
  });
});
