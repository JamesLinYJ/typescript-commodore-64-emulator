// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 磁盘旋转与磁头机构
//
//   文件:       Drive1541Mechanism.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { D64DiskImage } from '../../media/D64DiskImage';
import { G64DiskImage } from '../../media/G64DiskImage';
import {
  buildD64GcrTrack,
  decodeD64GcrTrack,
  D64_GCR_LAYOUT,
  d64SpeedZoneForTrack,
} from './CommodoreGcr';
import {
  Drive1541GcrCircuit,
  type Drive1541GcrBit,
  type Drive1541SpeedZone,
} from './Drive1541GcrCircuit';

export type { Drive1541SpeedZone } from './Drive1541GcrCircuit';

export const DRIVE_1541_MECHANISM = {
  bitsPerByte: 8,
  diskChange: {
    /** 插盘期间写保护光路被盘片边缘遮挡，并且读写头尚不能稳定访问介质。 */
    insertionCycles: 1_800_000,
    /** 拔盘时盘片边缘遮挡写保护光路的确定性持续时间。 */
    removalCycles: 600_000,
    /** 立即换盘时，两次遮挡脉冲之间必须保留的最短无盘窗口。 */
    replacementGapCycles: 1_200_000,
  },
  initialHalfTrack: 36,
  // G64 的 84 个表项从半轨 2 起算，因此最后一项是磁道 42.5（半轨 85）。
  maximumHalfTrack: 85,
  minimumHalfTrack: 2,
  nominalRevolutionsPerMinute: 300,
  referenceClockTicksPerCpuCycle: 16,
  referenceClockTicksPerRevolution: 3_200_000,
  referenceClockTicksPerBitBySpeedZone: [64, 60, 56, 52] as const,
  stepperPhaseMask: 0x03,
  syncBitCount: 10,
} as const;

export type Drive1541DiskImage = D64DiskImage | G64DiskImage;

export interface Drive1541ControlState {
  readonly ledOn: boolean;
  readonly motorOn: boolean;
  readonly speedZone: Drive1541SpeedZone;
  readonly stepperPhase: number;
}

export interface Drive1541ByteReadyTransition {
  readonly asserted: boolean;
  readonly dataByte: number;
  readonly sequence: number;
}

export type Drive1541ByteReadyObserver = (transition: Drive1541ByteReadyTransition) => void;

export interface Drive1541ByteReadyEdge {
  readonly dataByte: number;
  readonly sequence: number;
}

export type Drive1541ByteReadyEdgeObserver = (edge: Drive1541ByteReadyEdge) => void;

export interface Drive1541D64CommitFailure {
  readonly halfTrack: number;
  readonly reason: string;
}

export interface Drive1541D64CommitReport {
  readonly committedHalfTracks: readonly number[];
  readonly failures: readonly Drive1541D64CommitFailure[];
  readonly remainingDirtyHalfTracks: readonly number[];
}

/**
 * 模拟 1541 机械组件及读写数据通路。
 *
 * 该类只认识磁头、马达、GCR 位流和 BYTE READY，不认识 VIA 寄存器地址或 IEC
 * 协议。这样的边界允许磁盘格式适配器与芯片接线分别演进，而不会把 DOS 级快捷路径
 * 混入硬件时序。
 */
export class Drive1541Mechanism {
  private disk: Drive1541DiskImage | undefined;
  private readonly rawTracks = new Map<number, Uint8Array>();
  private readonly dirtyRawTracks = new Set<number>();
  private readonly byteReadyObservers = new Set<Drive1541ByteReadyObserver>();
  private readonly byteReadyEdgeObservers = new Set<Drive1541ByteReadyEdgeObserver>();
  private readonly gcrCircuit = new Drive1541GcrCircuit({
    signalByteReady: (dataByte) => this.signalByteReadyBoundary(dataByte),
    writeFluxBit: (bit) => this.writeFluxBit(bit),
  });

  private currentHalfTrackValue: number = DRIVE_1541_MECHANISM.initialHalfTrack;
  private angularBitOffsetValue = 0;
  private mediaRotationAccumulator = 0;
  private selectedSpeedZoneValue: Drive1541SpeedZone = 0;
  private motorOnValue = false;
  private ledOnValue = true;
  private readingValue = true;
  private byteReadyEnabledValue = true;
  private byteReadyAssertedValue = false;
  private byteReadySequence = 0;
  private byteReadyEdgeSequence = 0;
  private diskInsertionCyclesRemaining = 0;
  private diskRemovalCyclesRemaining = 0;
  private diskReplacementGapCyclesRemaining = 0;

  get diskPresent(): boolean {
    return this.disk !== undefined;
  }

  get mountedDisk(): Drive1541DiskImage | undefined {
    return this.disk;
  }

  get writeProtected(): boolean {
    // 这是写放大器的介质保护策略；无盘同样不能接受写入，但不代表 PB4 传感器有效。
    return this.disk?.writeProtected ?? true;
  }

  get writeProtectSensorActive(): boolean {
    // PB4 看到的是光电传感器，而不是“当前能否写入”的派生布尔值。快速换盘时三个
    // 同时推进的区间按拔出遮挡、无盘间隙、插入遮挡的优先级产生两次独立脉冲。
    if (this.diskRemovalCyclesRemaining > 0) return true;
    if (this.diskReplacementGapCyclesRemaining > 0) return false;
    if (this.diskInsertionCyclesRemaining > 0) return true;
    return this.disk?.writeProtected ?? false;
  }

  get currentHalfTrack(): number {
    return this.currentHalfTrackValue;
  }

  get currentTrack(): number {
    return this.currentHalfTrackValue / 2;
  }

  get angularBitOffset(): number {
    return this.angularBitOffsetValue;
  }

  get selectedSpeedZone(): Drive1541SpeedZone {
    return this.selectedSpeedZoneValue;
  }

  get motorOn(): boolean {
    return this.motorOnValue;
  }

  get ledOn(): boolean {
    return this.ledOnValue;
  }

  get reading(): boolean {
    return this.readingValue;
  }

  get byteReadyEnabled(): boolean {
    return this.byteReadyEnabledValue;
  }

  get byteReadyAsserted(): boolean {
    return this.byteReadyAssertedValue;
  }

  get dataByte(): number {
    return this.gcrCircuit.dataByte;
  }

  get writeDataByte(): number {
    return this.gcrCircuit.writeDataByte;
  }

  get syncFound(): boolean {
    return this.gcrCircuit.syncFound;
  }

  get dirtyHalfTracks(): readonly number[] {
    return [...this.dirtyRawTracks].sort((left, right) => left - right);
  }

  mountDisk(image: Drive1541DiskImage): void {
    if (this.disk) {
      throw new Error('A disk is already mounted; eject it before mounting another image.');
    }
    const replacingDuringRemoval = this.diskRemovalCyclesRemaining > 0;
    this.disk = image;
    this.diskInsertionCyclesRemaining = DRIVE_1541_MECHANISM.diskChange.insertionCycles;
    this.diskReplacementGapCyclesRemaining = replacingDuringRemoval
      ? DRIVE_1541_MECHANISM.diskChange.replacementGapCycles
      : 0;
    this.rawTracks.clear();
    this.dirtyRawTracks.clear();
    this.resetReadPathAtCurrentPosition();
  }

  ejectDisk(): Drive1541DiskImage {
    const image = this.disk;
    if (!image) throw new Error('Cannot eject a disk because the 1541 mechanism is empty.');
    if (image instanceof D64DiskImage && this.dirtyRawTracks.size !== 0) {
      throw new Error(
        'Cannot eject a D64 with uncommitted raw-track writes; commit or explicitly discard them first.',
      );
    }
    this.finishDiskRemoval();
    return image;
  }

  /**
   * 显式放弃尚不能由扇区型 D64 表达的原始磁道写入。
   *
   * 此操作故意使用单独的方法，避免普通 eject 在不提示调用方的情况下丢失磁通级修改。
   */
  discardRawTrackWritesAndEject(): D64DiskImage {
    const image = this.disk;
    if (!image) throw new Error('Cannot eject a disk because the 1541 mechanism is empty.');
    if (!(image instanceof D64DiskImage)) {
      throw new Error('Raw-track discard is only required for a mounted D64 image.');
    }
    this.dirtyRawTracks.clear();
    this.finishDiskRemoval();
    return image;
  }

  /**
   * 把完整、校验正确的偶数半轨显式投影回 D64 扇区。
   *
   * 成功提交意味着调用方接受 D64 不保存间隙、扇区物理顺序和自定义磁通的限制；任何
   * 无法无歧义解码的磁道都会保持 dirty，并在报告中给出原因。
   */
  commitRawTrackWritesToD64Sectors(): Drive1541D64CommitReport {
    const image = this.disk;
    if (!image) throw new Error('Cannot commit raw tracks without a mounted disk.');
    if (!(image instanceof D64DiskImage)) {
      throw new Error('Sector projection is only defined for a mounted D64 image.');
    }
    const committedHalfTracks: number[] = [];
    const failures: Drive1541D64CommitFailure[] = [];

    for (const halfTrack of this.dirtyHalfTracks) {
      const trackNumber = halfTrack / 2;
      if (!Number.isInteger(trackNumber) || trackNumber > image.trackCount) {
        failures.push({
          halfTrack,
          reason: 'D64 represents full tracks only, and this half-track has no sector projection.',
        });
        continue;
      }

      const decoded = decodeD64GcrTrack(this.rawTrackForHalfTrack(halfTrack));
      const sectorsOnTrack = image.sectorsOnTrack(trackNumber);
      const bySector = new Map<number, (typeof decoded.sectors)[number]>();
      let failureReason: string | undefined;
      for (const sector of decoded.sectors) {
        if (sector.track !== trackNumber) continue;
        if (bySector.has(sector.sector)) {
          failureReason = `Track ${trackNumber} contains duplicate sector ${sector.sector}.`;
          break;
        }
        bySector.set(sector.sector, sector);
      }
      if (!failureReason && bySector.size !== sectorsOnTrack) {
        failureReason = `Decoded ${bySector.size} of ${sectorsOnTrack} required sectors on track ${trackNumber}.`;
      }
      const diskIds = new Set(
        [...bySector.values()].map((sector) => `${sector.id1}:${sector.id2}`),
      );
      if (!failureReason && diskIds.size !== 1) {
        failureReason = `Track ${trackNumber} contains inconsistent disk IDs.`;
      }
      if (failureReason) {
        const firstDecodeIssue = decoded.issues[0];
        failures.push({
          halfTrack,
          reason: firstDecodeIssue
            ? `${failureReason} First decode issue at bit ${firstDecodeIssue.bitOffset}: ${firstDecodeIssue.reason}`
            : failureReason,
        });
        continue;
      }

      for (let sectorNumber = 0; sectorNumber < sectorsOnTrack; sectorNumber += 1) {
        const sector = bySector.get(sectorNumber);
        if (!sector) {
          throw new Error(`Validated GCR track is unexpectedly missing sector ${sectorNumber}.`);
        }
        image.writeSector(trackNumber, sectorNumber, sector.data);
      }
      this.dirtyRawTracks.delete(halfTrack);
      committedHalfTracks.push(halfTrack);
    }

    return {
      committedHalfTracks,
      failures,
      remainingDirtyHalfTracks: this.dirtyHalfTracks,
    };
  }

  observeByteReady(observer: Drive1541ByteReadyObserver): () => void {
    this.byteReadyObservers.add(observer);
    return () => this.byteReadyObservers.delete(observer);
  }

  observeByteReadyEdge(observer: Drive1541ByteReadyEdgeObserver): () => void {
    this.byteReadyEdgeObservers.add(observer);
    return () => this.byteReadyEdgeObservers.delete(observer);
  }

  applyControlState(state: Drive1541ControlState): void {
    const stepperPhase = requireStepperPhase(state.stepperPhase);
    const speedZone = requireSpeedZone(state.speedZone);

    // 线圈相位由 PB0..PB1 译码为四个绝对位置。只有新状态同时打开主轴马达时，
    // 相邻相位才会产生半轨移动；对置线圈相差两个相位，其机械结果不确定，因此不移动。
    const physicalStepperPosition =
      (this.currentHalfTrackValue - DRIVE_1541_MECHANISM.minimumHalfTrack) &
      DRIVE_1541_MECHANISM.stepperPhaseMask;
    const phaseDelta =
      (stepperPhase - physicalStepperPosition) & DRIVE_1541_MECHANISM.stepperPhaseMask;
    if (state.motorOn && (phaseDelta === 1 || phaseDelta === 3)) {
      this.moveHeadByHalfTrack(phaseDelta === 1 ? 1 : -1);
    }

    this.motorOnValue = state.motorOn;
    this.ledOnValue = state.ledOn;
    this.selectedSpeedZoneValue = speedZone;
    this.gcrCircuit.setSpeedZone(speedZone);
  }

  setMotorOn(motorOn: boolean): void {
    this.motorOnValue = motorOn;
  }

  setLedOn(ledOn: boolean): void {
    this.ledOnValue = ledOn;
  }

  setSpeedZone(speedZone: Drive1541SpeedZone): void {
    const normalized = requireSpeedZone(speedZone);
    this.selectedSpeedZoneValue = normalized;
    this.gcrCircuit.setSpeedZone(normalized);
  }

  setReadMode(reading: boolean): void {
    if (this.readingValue === reading) return;
    this.readingValue = reading;
    this.gcrCircuit.setReadMode(reading);
    this.setByteReadyAsserted(false);
  }

  setByteReadyEnabled(enabled: boolean): void {
    this.byteReadyEnabledValue = enabled;
    this.gcrCircuit.setByteReadyEnabled(enabled);
    if (!enabled) this.setByteReadyAsserted(false);
  }

  setWriteDataByte(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`1541 GCR write data must be one byte; received ${String(value)}.`);
    }
    this.gcrCircuit.setWriteDataByte(value);
  }

  acknowledgeByteReady(): void {
    this.setByteReadyAsserted(false);
  }

  tick(cpuCycles: number): void {
    if (!Number.isSafeInteger(cpuCycles) || cpuCycles < 0) {
      throw new RangeError(`1541 mechanism cycles must be a non-negative safe integer.`);
    }
    if (cpuCycles === 0) return;

    const headBlockedCycles = this.diskHeadBlockedCycles(cpuCycles);
    this.advanceDiskChange(cpuCycles);
    const rotatingCycles = cpuCycles - headBlockedCycles;
    if (!this.motorOnValue || rotatingCycles === 0) return;

    const addedReferenceTicks =
      rotatingCycles * DRIVE_1541_MECHANISM.referenceClockTicksPerCpuCycle;
    if (!Number.isSafeInteger(addedReferenceTicks)) {
      throw new RangeError('1541 mechanism tick interval is too large for exact cycle arithmetic.');
    }
    if (this.readingValue) this.advanceReadRotation(addedReferenceTicks);
    else this.advanceWriteRotation(addedReferenceTicks);
  }

  readRawHalfTrack(halfTrack: number): Uint8Array {
    requireHalfTrack(halfTrack);
    if (!this.disk) throw new Error('Cannot read a raw track without a mounted disk.');
    return this.rawTrackForHalfTrack(halfTrack).slice();
  }

  /** 复位读写分离电路；磁头所在半轨和盘片角位置不会因电子复位而跳变。 */
  resetElectronics(): void {
    this.gcrCircuit.reset();
    this.mediaRotationAccumulator = 0;
    this.setByteReadyAsserted(false);
  }

  private moveHeadByHalfTrack(step: -1 | 1): void {
    const previousTrackLength = this.currentTrackLengthBits();
    const angularFraction =
      previousTrackLength === 0
        ? 0
        : (this.angularBitOffsetValue +
            this.mediaRotationAccumulator / DRIVE_1541_MECHANISM.referenceClockTicksPerRevolution) /
          previousTrackLength;
    this.currentHalfTrackValue = Math.min(
      DRIVE_1541_MECHANISM.maximumHalfTrack,
      Math.max(DRIVE_1541_MECHANISM.minimumHalfTrack, this.currentHalfTrackValue + step),
    );
    const nextTrackLength = this.currentTrackLengthBits();
    const nextAngularPosition = angularFraction * nextTrackLength;
    this.angularBitOffsetValue = Math.min(nextTrackLength - 1, Math.floor(nextAngularPosition));
    this.mediaRotationAccumulator = Math.floor(
      (nextAngularPosition - this.angularBitOffsetValue) *
        DRIVE_1541_MECHANISM.referenceClockTicksPerRevolution,
    );
  }

  private advanceReadRotation(referenceTicks: number): void {
    let remaining = referenceTicks;
    while (remaining > 0) {
      const trackLengthBits = this.currentTrackLengthBits();
      const ticksUntilNextCell = Math.ceil(
        (DRIVE_1541_MECHANISM.referenceClockTicksPerRevolution - this.mediaRotationAccumulator) /
          trackLengthBits,
      );
      const interval = Math.min(remaining, ticksUntilNextCell);

      this.gcrCircuit.advance(interval);
      this.advanceMediaPhase(interval, trackLengthBits);
      remaining -= interval;

      if (this.mediaRotationAccumulator < DRIVE_1541_MECHANISM.referenceClockTicksPerRevolution) {
        if (this.syncFound) this.setByteReadyAsserted(false);
        continue;
      }

      this.mediaRotationAccumulator -= DRIVE_1541_MECHANISM.referenceClockTicksPerRevolution;
      if (this.readCurrentBit() === 1) this.gcrCircuit.observeRecordedFluxReversal();
      this.advanceAngularPosition();
      if (this.syncFound) this.setByteReadyAsserted(false);
    }
  }

  private advanceWriteRotation(referenceTicks: number): void {
    let remaining = referenceTicks;
    while (remaining > 0) {
      const interval = Math.min(remaining, this.gcrCircuit.referenceTicksUntilNextShift);
      this.advanceMediaPhase(interval, this.currentTrackLengthBits());
      this.gcrCircuit.advance(interval);
      remaining -= interval;
    }
  }

  private advanceMediaPhase(referenceTicks: number, trackLengthBits: number): void {
    const advance = referenceTicks * trackLengthBits;
    if (!Number.isSafeInteger(this.mediaRotationAccumulator + advance)) {
      throw new RangeError('1541 media rotation interval exceeds exact integer arithmetic.');
    }
    this.mediaRotationAccumulator += advance;
    if (!this.readingValue) {
      this.mediaRotationAccumulator %= DRIVE_1541_MECHANISM.referenceClockTicksPerRevolution;
    }
  }

  private writeFluxBit(bit: Drive1541GcrBit): void {
    if (!this.disk) return;
    this.writeCurrentBit(bit);
    this.advanceAngularPosition();
    // 写移位边沿重新把磁头相位置于位单元开始后的两个参考时钟，与读回相位保持连续。
    this.mediaRotationAccumulator = this.currentTrackLengthBits() * 2;
  }

  private readCurrentBit(): 0 | 1 {
    if (!this.disk) return 0;
    const track = this.rawTrackForHalfTrack(this.currentHalfTrackValue);
    const byteIndex = Math.floor(this.angularBitOffsetValue / DRIVE_1541_MECHANISM.bitsPerByte);
    const bitInByte = 7 - (this.angularBitOffsetValue % DRIVE_1541_MECHANISM.bitsPerByte);
    const value = track[byteIndex];
    if (value === undefined) {
      throw new RangeError(
        `1541 angular offset ${this.angularBitOffsetValue} is outside its track.`,
      );
    }
    return ((value >>> bitInByte) & 1) as 0 | 1;
  }

  private writeCurrentBit(bit: Drive1541GcrBit): void {
    const image = this.disk;
    if (!image || image.writeProtected) return;
    const track = this.rawTrackForHalfTrack(this.currentHalfTrackValue);
    const byteIndex = Math.floor(this.angularBitOffsetValue / DRIVE_1541_MECHANISM.bitsPerByte);
    const bitInByte = 7 - (this.angularBitOffsetValue % DRIVE_1541_MECHANISM.bitsPerByte);
    const previous = track[byteIndex];
    if (previous === undefined) {
      throw new RangeError(
        `1541 angular offset ${this.angularBitOffsetValue} is outside its track.`,
      );
    }
    const mask = 1 << bitInByte;
    const next = bit === 0 ? previous & ~mask : previous | mask;
    track[byteIndex] = next;
    if (image instanceof G64DiskImage) {
      if (!image.hasHalfTrack(this.currentHalfTrackValue)) {
        image.setHalfTrack(this.currentHalfTrackValue, track, {
          kind: 'constant',
          zone: this.selectedSpeedZoneValue,
        });
      }
      // G64 能表示真实磁道和逐字节写入速度，因此修改立即属于镜像本身，不进入 D64
      // 的“待投影扇区”集合。
      image.writeHalfTrackByte(
        this.currentHalfTrackValue,
        byteIndex,
        next,
        this.selectedSpeedZoneValue,
      );
    } else {
      this.dirtyRawTracks.add(this.currentHalfTrackValue);
    }
  }

  private finishDiskRemoval(): void {
    this.disk = undefined;
    this.diskInsertionCyclesRemaining = 0;
    this.diskReplacementGapCyclesRemaining = 0;
    this.diskRemovalCyclesRemaining = DRIVE_1541_MECHANISM.diskChange.removalCycles;
    this.rawTracks.clear();
    this.resetReadPathAtCurrentPosition();
  }

  private diskHeadBlockedCycles(cpuCycles: number): number {
    if (!this.disk) return 0;
    // VICE diskchange 参考协议使用固定区间表示人手插拔；插入完成前不让读写头提前看到
    // 完整镜像，避免传感器仍在遮挡时软件已经能读取稳定同步标记的矛盾状态。
    const remaining = Math.max(
      this.diskInsertionCyclesRemaining,
      this.diskReplacementGapCyclesRemaining,
    );
    return Math.min(cpuCycles, remaining);
  }

  private advanceDiskChange(cpuCycles: number): void {
    this.diskInsertionCyclesRemaining = Math.max(0, this.diskInsertionCyclesRemaining - cpuCycles);
    this.diskRemovalCyclesRemaining = Math.max(0, this.diskRemovalCyclesRemaining - cpuCycles);
    this.diskReplacementGapCyclesRemaining = Math.max(
      0,
      this.diskReplacementGapCyclesRemaining - cpuCycles,
    );
  }

  private advanceAngularPosition(): void {
    const trackLength = this.currentTrackLengthBits();
    this.angularBitOffsetValue = (this.angularBitOffsetValue + 1) % trackLength;
  }

  private currentTrackLengthBits(): number {
    return (
      this.rawTrackSizeForHalfTrack(this.currentHalfTrackValue) * DRIVE_1541_MECHANISM.bitsPerByte
    );
  }

  private rawTrackForHalfTrack(halfTrack: number): Uint8Array {
    const cached = this.rawTracks.get(halfTrack);
    if (cached) return cached;

    const image = this.disk;
    if (!image) throw new Error('Cannot materialize a raw track without a mounted disk.');
    const trackNumber = Math.floor(halfTrack / 2);
    let track: Uint8Array;
    if (image instanceof G64DiskImage) {
      const storedTrack = image.readHalfTrack(halfTrack);
      track = storedTrack?.bytes ?? new Uint8Array(this.rawTrackSizeForHalfTrack(halfTrack));
    } else {
      const isRepresentedD64Track = halfTrack % 2 === 0 && trackNumber <= image.trackCount;
      track = isRepresentedD64Track
        ? buildD64GcrTrack(image, trackNumber).bytes
        : new Uint8Array(this.rawTrackSizeForHalfTrack(halfTrack));
    }
    this.rawTracks.set(halfTrack, track);
    return track;
  }

  private rawTrackSizeForHalfTrack(halfTrack: number): number {
    const normalizedHalfTrack = requireHalfTrack(halfTrack);
    if (this.disk instanceof G64DiskImage) {
      const storedTrack = this.disk.readHalfTrack(normalizedHalfTrack);
      if (storedTrack) return storedTrack.bytes.length;
    }
    const trackNumber = Math.floor(normalizedHalfTrack / 2);
    const speedZone = d64SpeedZoneForTrack(trackNumber);
    return D64_GCR_LAYOUT.rawTrackSizeBySpeedZone[speedZone];
  }

  private resetReadPathAtCurrentPosition(): void {
    this.angularBitOffsetValue = 0;
    this.mediaRotationAccumulator = 0;
    this.gcrCircuit.reset();
    this.setByteReadyAsserted(false);
  }

  private setByteReadyAsserted(asserted: boolean): void {
    if (this.byteReadyAssertedValue === asserted) return;
    this.byteReadyAssertedValue = asserted;
    this.byteReadySequence += 1;
    const transition = {
      asserted,
      dataByte: this.dataByte,
      sequence: this.byteReadySequence,
    } as const;
    for (const observer of [...this.byteReadyObservers]) observer(transition);
  }

  private signalByteReadyBoundary(dataByte: number): void {
    if (!this.byteReadyEnabledValue) return;

    // 1541 的 BYTE READY 同时具有两种可观察语义：VIA2 CA1 看到的是保持到端口访问的
    // 电平，而 6502 SO 看到的是每个完整字节产生的一次边沿。ROM 写同步区会连续执行
    // CLV/BVC 而不访问 VIA，所以即使 CA1 电平尚未撤销，后续字节仍必须继续产生 SO。
    this.byteReadyEdgeSequence += 1;
    const edge = {
      dataByte,
      sequence: this.byteReadyEdgeSequence,
    } as const;
    for (const observer of [...this.byteReadyEdgeObservers]) observer(edge);
    this.setByteReadyAsserted(true);
  }
}

function requireSpeedZone(speedZone: number): Drive1541SpeedZone {
  if (!Number.isInteger(speedZone) || speedZone < 0 || speedZone > 3) {
    throw new RangeError(`1541 speed zone must be an integer from 0 through 3.`);
  }
  return speedZone as Drive1541SpeedZone;
}

function requireStepperPhase(stepperPhase: number): number {
  if (!Number.isInteger(stepperPhase) || stepperPhase < 0 || stepperPhase > 3) {
    throw new RangeError(`1541 stepper phase must be an integer from 0 through 3.`);
  }
  return stepperPhase;
}

function requireHalfTrack(halfTrack: number): number {
  if (
    !Number.isInteger(halfTrack) ||
    halfTrack < DRIVE_1541_MECHANISM.minimumHalfTrack ||
    halfTrack > DRIVE_1541_MECHANISM.maximumHalfTrack
  ) {
    throw new RangeError(
      `1541 half-track must be an integer from ${DRIVE_1541_MECHANISM.minimumHalfTrack} through ${DRIVE_1541_MECHANISM.maximumHalfTrack}.`,
    );
  }
  return halfTrack;
}
