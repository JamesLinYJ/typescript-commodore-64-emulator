// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 磁盘控制 VIA 测试
//
//   文件:       Drive1541DiskVia.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  MOS_6522_INTERRUPT_BIT,
  MOS_6522_PCR_CONTROL_MODE,
  MOS_6522_REGISTER,
} from '../../src/devices/Mos6522Registers';
import { D64DiskImage, D64_LAYOUT, d64SectorCountThroughTrack } from '../../src/media/D64DiskImage';
import {
  DRIVE_1541_DISK_PORT_B_BIT,
  Drive1541DiskVia,
} from '../../src/peripherals/drive1541/Drive1541DiskVia';
import {
  DRIVE_1541_MECHANISM,
  Drive1541Mechanism,
} from '../../src/peripherals/drive1541/Drive1541Mechanism';

function createDisk(writeProtected = false): D64DiskImage {
  const bytes = new Uint8Array(d64SectorCountThroughTrack(35) * D64_LAYOUT.sectorSize);
  const directoryOffset = d64SectorCountThroughTrack(17) * D64_LAYOUT.sectorSize;
  bytes[directoryOffset + D64_LAYOUT.directoryHeader.diskId1Offset] = 0x4a;
  bytes[directoryOffset + D64_LAYOUT.directoryHeader.diskId2Offset] = 0x53;
  return new D64DiskImage(bytes, { writeProtected });
}

function createDiskVia(): {
  readonly mechanism: Drive1541Mechanism;
  readonly via: Drive1541DiskVia;
} {
  const mechanism = new Drive1541Mechanism();
  const via = new Drive1541DiskVia({ deviceNumber: 8, mechanism });
  return { mechanism, via };
}

describe('Drive1541DiskVia', () => {
  it('maps PB0..PB6 to stepper, motor, LED, and speed-zone controls', () => {
    const { mechanism, via } = createDiskVia();
    via.write(MOS_6522_REGISTER.dataDirectionB, 0x6f);
    via.write(
      MOS_6522_REGISTER.portB,
      3 | DRIVE_1541_DISK_PORT_B_BIT.motor | DRIVE_1541_DISK_PORT_B_BIT.led | (2 << 5),
    );

    expect(mechanism.currentHalfTrack).toBe(37);
    expect(mechanism.motorOn).toBe(true);
    expect(mechanism.ledOn).toBe(true);
    expect(mechanism.selectedSpeedZone).toBe(2);
  });

  it('reports active-low SYNC and the write-protect sensor on input-configured PB pins', () => {
    const { mechanism, via } = createDiskVia();
    // 无盘时光路未被遮挡，PB4 为高；“没有可写介质”不能冒充传感器被触发。
    expect(via.read(MOS_6522_REGISTER.portB)).toBe(0xff);

    mechanism.mountDisk(createDisk());
    expect(via.read(MOS_6522_REGISTER.portB)).toBe(0xef);
    mechanism.tick(DRIVE_1541_MECHANISM.diskChange.insertionCycles);
    expect(via.read(MOS_6522_REGISTER.portB)).toBe(0xff);
    mechanism.setSpeedZone(2);
    mechanism.setMotorOn(true);
    mechanism.tick(34);
    expect(mechanism.syncFound).toBe(true);
    expect(via.read(MOS_6522_REGISTER.portB)).toBe(0x7f);
  });

  it('keeps PB4 low after a write-protected disk has finished insertion', () => {
    const { mechanism, via } = createDiskVia();
    mechanism.mountDisk(createDisk(true));
    expect(via.read(MOS_6522_REGISTER.portB)).toBe(0xef);

    mechanism.tick(DRIVE_1541_MECHANISM.diskChange.insertionCycles);

    expect(via.read(MOS_6522_REGISTER.portB)).toBe(0xef);
    expect(mechanism.writeProtected).toBe(true);
  });

  it('latches a disk byte through CA1 and acknowledges BYTE READY on Port A reads', () => {
    const { mechanism, via } = createDiskVia();
    mechanism.mountDisk(createDisk());
    mechanism.tick(DRIVE_1541_MECHANISM.diskChange.insertionCycles);
    mechanism.setSpeedZone(2);
    mechanism.setMotorOn(true);
    via.write(
      MOS_6522_REGISTER.interruptEnable,
      MOS_6522_INTERRUPT_BIT.any | MOS_6522_INTERRUPT_BIT.ca1,
    );
    mechanism.tick(172);

    expect(mechanism.byteReadyAsserted).toBe(true);
    expect(via.interruptPending).toBe(true);
    expect(via.read(MOS_6522_REGISTER.portA)).toBe(mechanism.dataByte);
    expect(mechanism.byteReadyAsserted).toBe(false);
    expect(via.read(MOS_6522_REGISTER.interruptFlags) & MOS_6522_INTERRUPT_BIT.ca1).toBe(0);
  });

  it('uses CA2 for BYTE READY enable and CB2 for read/write head mode', () => {
    const { mechanism, via } = createDiskVia();
    via.write(
      MOS_6522_REGISTER.peripheralControl,
      (MOS_6522_PCR_CONTROL_MODE.lowOutput << 1) | (MOS_6522_PCR_CONTROL_MODE.highOutput << 5),
    );
    expect(mechanism.byteReadyEnabled).toBe(false);
    expect(mechanism.reading).toBe(true);

    via.write(
      MOS_6522_REGISTER.peripheralControl,
      (MOS_6522_PCR_CONTROL_MODE.highOutput << 1) | (MOS_6522_PCR_CONTROL_MODE.lowOutput << 5),
    );
    expect(mechanism.byteReadyEnabled).toBe(true);
    expect(mechanism.reading).toBe(false);
  });

  it('delivers the effective Port A output pins to the parallel GCR write latch', () => {
    const { mechanism, via } = createDiskVia();
    via.write(MOS_6522_REGISTER.dataDirectionA, 0xff);
    via.write(MOS_6522_REGISTER.portA, 0xa5);
    expect(mechanism.writeDataByte).toBe(0xa5);
  });

  it('restores electronics without moving the physical head during reset', () => {
    const { mechanism, via } = createDiskVia();
    mechanism.applyControlState({ ledOn: false, motorOn: true, speedZone: 3, stepperPhase: 3 });
    expect(mechanism.currentHalfTrack).toBe(37);

    via.reset();
    expect(mechanism.currentHalfTrack).toBe(37);
    expect(mechanism.motorOn).toBe(false);
    expect(mechanism.ledOn).toBe(true);
    expect(mechanism.selectedSpeedZone).toBe(0);
    expect(mechanism.reading).toBe(true);
    expect(mechanism.byteReadyEnabled).toBe(true);
  });
});
