// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 磁盘机构测试
//
//   文件:       Drive1541Mechanism.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { D64DiskImage, D64_LAYOUT, d64SectorCountThroughTrack } from '../../src/media/D64DiskImage';
import { G64DiskImage, G64_LAYOUT } from '../../src/media/G64DiskImage';
import { D64_GCR_LAYOUT } from '../../src/peripherals/drive1541/CommodoreGcr';
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

function createG64Disk(): G64DiskImage {
  const halfTrackCount = G64_LAYOUT.maximumHalfTrackCount;
  const maximumTrackLength = 16;
  const bytes = new Uint8Array(G64_LAYOUT.headerSize + halfTrackCount * 8);
  bytes.set(Uint8Array.from(G64_LAYOUT.signature, (character) => character.charCodeAt(0)));
  bytes[G64_LAYOUT.versionOffset] = G64_LAYOUT.supportedVersion;
  bytes[G64_LAYOUT.trackCountOffset] = halfTrackCount;
  bytes[G64_LAYOUT.maximumTrackLengthOffset] = maximumTrackLength;
  const image = new G64DiskImage(bytes);
  image.setHalfTrack(36, new Uint8Array(maximumTrackLength).fill(0xff), {
    kind: 'constant',
    zone: 0,
  });
  return image;
}

function finishDiskInsertion(mechanism: Drive1541Mechanism): void {
  mechanism.tick(DRIVE_1541_MECHANISM.diskChange.insertionCycles);
}

describe('Drive1541Mechanism', () => {
  it('starts on directory track 18 and does not rotate while the motor is stopped', () => {
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(createDisk());
    mechanism.tick(10_000);

    expect(mechanism.currentHalfTrack).toBe(DRIVE_1541_MECHANISM.initialHalfTrack);
    expect(mechanism.currentTrack).toBe(18);
    expect(mechanism.angularBitOffset).toBe(0);
    expect(mechanism.motorOn).toBe(false);
  });

  it('detects ten sync bits and presents the following GCR byte on an exact byte boundary', () => {
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(createDisk());
    finishDiskInsertion(mechanism);
    mechanism.setSpeedZone(2);
    mechanism.setMotorOn(true);
    const transitions: boolean[] = [];
    mechanism.observeByteReady(({ asserted }) => transitions.push(asserted));

    // 7142 字节磁道在 300 RPM 下每转使用 320 万个 16 MHz 时钟；读分离器在第 34 个
    // CPU 周期确认十位同步，而不是把镜像位直接按固定 56 时钟搬进移位寄存器。
    mechanism.tick(34);
    expect(mechanism.syncFound).toBe(true);
    expect(mechanism.byteReadyAsserted).toBe(false);
    // 上电后的移位寄存器尚未装满十位，最初八个 1 可能先形成一次字节边界；
    // 同步检测在第十位确认后会立即撤销它，后续断言只观察同步后的正式字节。
    transitions.length = 0;

    // SO 必须等 UE3 对齐到 CPU 相位后才产生 BYTE READY；第一个头字节在总计 172 个
    // CPU 周期时完成锁存。
    mechanism.tick(138);
    const rawTrack = mechanism.readRawHalfTrack(36);
    expect(mechanism.angularBitOffset).toBe(49);
    expect(mechanism.dataByte).toBe(rawTrack[D64_GCR_LAYOUT.syncLength]);
    expect(mechanism.byteReadyAsserted).toBe(true);
    expect(transitions).toEqual([true]);

    mechanism.acknowledgeByteReady();
    expect(mechanism.byteReadyAsserted).toBe(false);
    expect(transitions).toEqual([true, false]);
  });

  it('rotates from track length and 300 RPM without floating-point timing error', () => {
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(createDisk());
    finishDiskInsertion(mechanism);
    mechanism.setMotorOn(true);

    mechanism.setSpeedZone(0);
    mechanism.tick(40);
    expect(mechanism.angularBitOffset).toBe(11);

    // PB5/PB6 改变 UE7 读写分频，不改变主轴的物理角速度。
    mechanism.setSpeedZone(3);
    mechanism.tick(13);
    expect(mechanism.angularBitOffset).toBe(15);
  });

  it('moves only one half-track for an adjacent energized stepper phase', () => {
    const mechanism = new Drive1541Mechanism();
    const controlBase = { ledOn: false, motorOn: true, speedZone: 0 as const };

    mechanism.applyControlState({ ...controlBase, stepperPhase: 3 });
    expect(mechanism.currentHalfTrack).toBe(37);

    mechanism.applyControlState({ ...controlBase, stepperPhase: 2 });
    expect(mechanism.currentHalfTrack).toBe(36);

    mechanism.applyControlState({ ...controlBase, stepperPhase: 0 });
    expect(mechanism.currentHalfTrack).toBe(36);

    mechanism.applyControlState({ ...controlBase, motorOn: false, stepperPhase: 3 });
    expect(mechanism.currentHalfTrack).toBe(36);
  });

  it('serializes write bytes into the raw track while preserving write protection', () => {
    const writable = new Drive1541Mechanism();
    writable.mountDisk(createDisk());
    finishDiskInsertion(writable);
    writable.setSpeedZone(0);
    writable.setWriteDataByte(0xa5);
    writable.setReadMode(false);
    writable.setMotorOn(true);
    writable.tick(32);

    // 读写共用串行寄存器；进入写模式后的第一个字节是此前锁存值，首个 BYTE READY
    // 边界才从 VIA Port A 重装 $A5。
    expect(writable.readRawHalfTrack(36)[0]).toBe(0x00);
    writable.tick(32);
    expect(writable.readRawHalfTrack(36)[1]).toBe(0xa5);
    expect(writable.dirtyHalfTracks).toEqual([36]);
    expect(writable.byteReadyAsserted).toBe(true);
    expect(() => writable.ejectDisk()).toThrow(/uncommitted raw-track writes/);
    expect(writable.commitRawTrackWritesToD64Sectors()).toEqual({
      committedHalfTracks: [36],
      failures: [],
      remainingDirtyHalfTracks: [],
    });
    expect(writable.ejectDisk()).toBeInstanceOf(D64DiskImage);

    const protectedMechanism = new Drive1541Mechanism();
    protectedMechanism.mountDisk(createDisk(true));
    finishDiskInsertion(protectedMechanism);
    protectedMechanism.setSpeedZone(0);
    protectedMechanism.setWriteDataByte(0xa5);
    protectedMechanism.setReadMode(false);
    protectedMechanism.setMotorOn(true);
    protectedMechanism.tick(64);
    expect(protectedMechanism.readRawHalfTrack(36)[0]).toBe(0xff);
    expect(protectedMechanism.dirtyHalfTracks).toEqual([]);
  });

  it('blocks the complete VICE raw-writer pattern at the physical write head', () => {
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(createDisk(true));
    finishDiskInsertion(mechanism);
    const before = mechanism.readRawHalfTrack(36);
    let byteReadyEdges = 0;
    mechanism.observeByteReadyEdge(() => {
      byteReadyEdges += 1;
    });
    mechanism.setSpeedZone(0);
    mechanism.setReadMode(false);
    mechanism.setMotorOn(true);

    const writeBytes = (value: number, count: number): void => {
      mechanism.setWriteDataByte(value);
      mechanism.tick(count * 32);
    };

    const leadByteCount = 0x3000;
    const alternatingPairCount = 0x0200;
    const tailByteCount = 0x0d;

    // VICE drive/writeprotect/writer.s 绕过 DOS，直接经 VIA2 写入 $3000 个 D7、
    // 512 对 DE/AD 和 13 个 55，最后再等待一个写字节边界。受保护介质仍要产生 BYTE READY/SO，
    // 让驱动器程序正常结束，但写放大器不能改变任何一个磁道位。
    writeBytes(0xd7, leadByteCount);
    for (let index = 0; index < alternatingPairCount; index += 1) {
      writeBytes(0xde, 1);
      writeBytes(0xad, 1);
    }
    writeBytes(0x55, tailByteCount + 1);

    expect(byteReadyEdges).toBe(leadByteCount + alternatingPairCount * 2 + tailByteCount + 1);
    expect(mechanism.readRawHalfTrack(36)).toEqual(before);
    expect(mechanism.dirtyHalfTracks).toEqual([]);
  });

  it('models the write-protect sensor independently from media writability', () => {
    const mechanism = new Drive1541Mechanism();
    expect(mechanism.writeProtected).toBe(true);
    expect(mechanism.writeProtectSensorActive).toBe(false);

    mechanism.mountDisk(createDisk());
    expect(mechanism.writeProtected).toBe(false);
    expect(mechanism.writeProtectSensorActive).toBe(true);
    mechanism.tick(DRIVE_1541_MECHANISM.diskChange.insertionCycles - 1);
    expect(mechanism.writeProtectSensorActive).toBe(true);
    mechanism.tick(1);
    expect(mechanism.writeProtectSensorActive).toBe(false);

    mechanism.ejectDisk();
    expect(mechanism.writeProtected).toBe(true);
    expect(mechanism.writeProtectSensorActive).toBe(true);
    mechanism.tick(DRIVE_1541_MECHANISM.diskChange.removalCycles - 1);
    expect(mechanism.writeProtectSensorActive).toBe(true);
    mechanism.tick(1);
    expect(mechanism.writeProtectSensorActive).toBe(false);
  });

  it('reproduces both sensor pulses during an immediate writable-disk replacement', () => {
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(createDisk());
    finishDiskInsertion(mechanism);
    expect(mechanism.writeProtectSensorActive).toBe(false);

    mechanism.ejectDisk();
    mechanism.mountDisk(createDisk());
    expect(mechanism.writeProtectSensorActive).toBe(true);

    mechanism.tick(DRIVE_1541_MECHANISM.diskChange.removalCycles);
    expect(mechanism.writeProtectSensorActive).toBe(false);

    mechanism.tick(
      DRIVE_1541_MECHANISM.diskChange.replacementGapCycles -
        DRIVE_1541_MECHANISM.diskChange.removalCycles,
    );
    expect(mechanism.writeProtectSensorActive).toBe(true);

    mechanism.tick(
      DRIVE_1541_MECHANISM.diskChange.insertionCycles -
        DRIVE_1541_MECHANISM.diskChange.replacementGapCycles,
    );
    expect(mechanism.writeProtectSensorActive).toBe(false);
  });

  it('emits one SO edge per written byte while retaining the VIA-visible BYTE READY level', () => {
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(createDisk());
    finishDiskInsertion(mechanism);
    mechanism.setSpeedZone(0);
    mechanism.setWriteDataByte(0xff);
    mechanism.setReadMode(false);
    mechanism.setMotorOn(true);
    const edgeSequences: number[] = [];
    const levelTransitions: boolean[] = [];
    mechanism.observeByteReadyEdge(({ sequence }) => edgeSequences.push(sequence));
    mechanism.observeByteReady(({ asserted }) => levelTransitions.push(asserted));

    // Zone 0 每 32 个 CPU 周期完成一个字节；未访问 VIA2 时 CA1 电平保持断言，
    // 但直接连到 6502 SO 的字节边沿仍会在每个边界重新发生。
    mechanism.tick(64);

    expect(edgeSequences).toEqual([1, 2]);
    expect(levelTransitions).toEqual([true]);
    expect(mechanism.byteReadyAsserted).toBe(true);
  });

  it('mounts G64 half-tracks and writes raw bytes with their physical speed zone', () => {
    const image = createG64Disk();
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(image);
    finishDiskInsertion(mechanism);
    expect(mechanism.readRawHalfTrack(36)).toEqual(new Uint8Array(16).fill(0xff));

    mechanism.setSpeedZone(2);
    mechanism.setWriteDataByte(0xa5);
    mechanism.setReadMode(false);
    mechanism.setMotorOn(true);
    // UE7/UF4 先移出共享寄存器的旧值，再在首个字节边界装载 $A5。
    mechanism.tick(56);

    expect(image.readHalfTrack(36)?.bytes[0]).toBe(0x00);
    expect(image.readHalfTrack(36)?.bytes[1]).toBe(0xa5);
    expect(image.speedZoneAtByte(36, 0)).toBe(2);
    expect(image.speedZoneAtByte(36, 1)).toBe(2);
    expect(mechanism.dirtyHalfTracks).toEqual([]);
    expect(mechanism.ejectDisk()).toBe(image);
  });

  it('keeps G64 speed metadata separate from physical spindle rotation', () => {
    const image = createG64Disk();
    image.setHalfTrack(36, Uint8Array.of(0x00, 0x00), { kind: 'constant', zone: 0 });
    image.writeHalfTrackByte(36, 0, 0x00, 2);
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(image);
    finishDiskInsertion(mechanism);
    mechanism.setMotorOn(true);

    // 两字节测试磁道每个物理位单元占 3200000 / 16 个参考时钟；速度表描述写入密度，
    // 不能让同一圈盘片在字节边界突然改变 RPM。
    mechanism.tick(12_500);
    expect(mechanism.angularBitOffset).toBe(1);
    mechanism.tick(12_500 * 15);
    expect(mechanism.angularBitOffset).toBe(0);
  });

  it('treats an absent G64 half-track as no recorded flux instead of stable $55 data', () => {
    const image = createG64Disk();
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(image);
    finishDiskInsertion(mechanism);
    const observedBytes: number[] = [];
    mechanism.observeByteReadyEdge(({ dataByte }) => observedBytes.push(dataByte));
    mechanism.applyControlState({ ledOn: false, motorOn: true, speedZone: 2, stepperPhase: 1 });

    expect(mechanism.readRawHalfTrack(35)).toEqual(
      new Uint8Array(D64_GCR_LAYOUT.rawTrackSizeBySpeedZone[3]),
    );
    mechanism.tick(2_000);

    expect(new Set(observedBytes).size).toBeGreaterThan(1);
    expect(observedBytes.some((value) => value !== 0x55)).toBe(true);
  });

  it('keeps half-track writes dirty when the D64 container cannot represent them', () => {
    const mechanism = new Drive1541Mechanism();
    mechanism.mountDisk(createDisk());
    finishDiskInsertion(mechanism);
    mechanism.applyControlState({ ledOn: false, motorOn: true, speedZone: 0, stepperPhase: 3 });
    expect(mechanism.currentHalfTrack).toBe(37);
    mechanism.setWriteDataByte(0x55);
    mechanism.setReadMode(false);
    mechanism.tick(32);

    const report = mechanism.commitRawTrackWritesToD64Sectors();
    expect(report.committedHalfTracks).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.reason).toMatch(/full tracks only/);
    expect(report.remainingDirtyHalfTracks).toEqual([37]);
    mechanism.discardRawTrackWritesAndEject();
  });

  it('requires explicit lifecycle operations instead of silently replacing or losing media', () => {
    const mechanism = new Drive1541Mechanism();
    const firstDisk = createDisk();
    mechanism.mountDisk(firstDisk);
    expect(() => mechanism.mountDisk(createDisk())).toThrow(/already mounted/);
    expect(mechanism.ejectDisk()).toBe(firstDisk);
    expect(() => mechanism.ejectDisk()).toThrow(/empty/);
  });
});
