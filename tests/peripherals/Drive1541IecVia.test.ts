// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 IEC 接口 VIA 测试
//
//   文件:       Drive1541IecVia.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { MOS_6522_INTERRUPT_BIT, MOS_6522_REGISTER } from '../../src/devices/Mos6522Registers';
import {
  Drive1541IecVia,
  DRIVE_1541_IEC_PORT_B_BIT,
} from '../../src/peripherals/drive1541/Drive1541IecVia';
import { IecBus, IEC_LINE } from '../../src/peripherals/iec/IecBus';

describe('Drive1541IecVia', () => {
  it('reads physical IEC levels and device-address switches on VIA1 Port B', () => {
    const bus = new IecBus();
    const host = bus.attach('test host');
    const drive8 = new Drive1541IecVia({ deviceNumber: 8, iecBus: bus });
    const drive9 = new Drive1541IecVia({ deviceNumber: 9, iecBus: bus });

    expect(drive8.read(MOS_6522_REGISTER.portB)).toBe(0x1a);
    expect(drive9.read(MOS_6522_REGISTER.portB)).toBe(0x3a);

    host.setPulledLowLines([IEC_LINE.attention, IEC_LINE.clock, IEC_LINE.data]);
    expect(drive8.read(MOS_6522_REGISTER.portB) & 0x85).toBe(0x85);
  });

  it('inverts CLOCK/DATA outputs and applies the ATNA equality gate', () => {
    const bus = new IecBus();
    const host = bus.attach('test host');
    const via = new Drive1541IecVia({ deviceNumber: 8, iecBus: bus });
    via.write(MOS_6522_REGISTER.portB, 0x00);
    via.write(MOS_6522_REGISTER.dataDirectionB, 0x1a);
    expect(bus.state).toMatchObject({ clockHigh: true, dataHigh: true });

    via.write(MOS_6522_REGISTER.portB, DRIVE_1541_IEC_PORT_B_BIT.clockOutput);
    expect(bus.state.clockHigh).toBe(false);

    via.write(MOS_6522_REGISTER.portB, DRIVE_1541_IEC_PORT_B_BIT.dataOutput);
    expect(bus.state).toMatchObject({ clockHigh: true, dataHigh: false });

    via.write(MOS_6522_REGISTER.portB, 0x00);
    expect(bus.state.dataHigh).toBe(true);

    host.setPulledLow(IEC_LINE.attention, true);
    expect(bus.state.dataHigh).toBe(false);

    via.write(MOS_6522_REGISTER.portB, DRIVE_1541_IEC_PORT_B_BIT.attentionAcknowledgeOutput);
    expect(bus.state.dataHigh).toBe(true);

    host.setPulledLow(IEC_LINE.attention, false);
    expect(bus.state.dataHigh).toBe(false);
  });

  it('acknowledges ATN with the DDRB=$1A and ORB=$00 state used by the DOS ROM', () => {
    const bus = new IecBus();
    const host = bus.attach('test host');
    const via = new Drive1541IecVia({ deviceNumber: 8, iecBus: bus });
    via.write(MOS_6522_REGISTER.portB, 0x00);
    via.write(MOS_6522_REGISTER.dataDirectionB, 0x1a);

    expect(bus.state).toMatchObject({ clockHigh: true, dataHigh: true });
    host.setPulledLow(IEC_LINE.attention, true);
    expect(bus.state).toMatchObject({ clockHigh: true, dataHigh: false });
  });

  it('inverts asserted ATN into the positive CA1 edge selected by the DOS ROM', () => {
    const bus = new IecBus();
    const host = bus.attach('test host');
    const via = new Drive1541IecVia({ deviceNumber: 8, iecBus: bus });
    via.write(MOS_6522_REGISTER.peripheralControl, 0x01);
    via.write(
      MOS_6522_REGISTER.interruptEnable,
      MOS_6522_INTERRUPT_BIT.any | MOS_6522_INTERRUPT_BIT.ca1,
    );

    host.setPulledLow(IEC_LINE.attention, true);

    expect(via.interruptPending).toBe(true);
    expect(via.read(MOS_6522_REGISTER.interruptFlags)).toBe(
      MOS_6522_INTERRUPT_BIT.any | MOS_6522_INTERRUPT_BIT.ca1,
    );

    via.write(MOS_6522_REGISTER.interruptFlags, MOS_6522_INTERRUPT_BIT.ca1);
    host.setPulledLow(IEC_LINE.attention, false);
    expect(via.interruptPending).toBe(false);
  });

  it('releases IEC lines and allows the device number to be reused after disconnect', () => {
    const bus = new IecBus();
    const via = new Drive1541IecVia({ deviceNumber: 8, iecBus: bus });
    via.write(MOS_6522_REGISTER.dataDirectionB, DRIVE_1541_IEC_PORT_B_BIT.clockOutput);
    via.write(MOS_6522_REGISTER.portB, DRIVE_1541_IEC_PORT_B_BIT.clockOutput);
    expect(bus.state.clockHigh).toBe(false);

    via.disconnect();

    expect(bus.state.clockHigh).toBe(true);
    expect(() => new Drive1541IecVia({ deviceNumber: 8, iecBus: bus })).not.toThrow();
    expect(() => via.disconnect()).toThrow(/already disconnected/);
  });
});
