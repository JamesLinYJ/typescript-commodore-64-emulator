// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 磁盘控制 VIA
//
//   文件:       Drive1541DiskVia.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Mos6522 } from '../../devices/Mos6522';
import { MOS_6522_CONTROL_LINE, type Mos6522ControlLine } from '../../devices/Mos6522Registers';
import { Drive1541Mechanism, type Drive1541SpeedZone } from './Drive1541Mechanism';

export const DRIVE_1541_DISK_PORT_B_BIT = {
  stepperPhaseMask: 0x03,
  motor: 1 << 2,
  led: 1 << 3,
  writeProtectSensor: 1 << 4,
  speedZoneMask: 0x60,
  syncNotFound: 1 << 7,
} as const;

const DRIVE_1541_DISK_PORT_B_UNUSED_INPUTS_HIGH = 0x6f;

export interface Drive1541DiskViaOptions {
  readonly debug?: boolean;
  readonly deviceNumber: number;
  readonly mechanism: Drive1541Mechanism;
}

/** 把 6522 的引脚电平映射到 1541 磁盘机构；寄存器行为仍完全由 Mos6522 负责。 */
export class Drive1541DiskVia extends Mos6522 {
  readonly deviceNumber: number;

  private mechanismValue: Drive1541Mechanism | undefined;
  private stopObservingByteReady: (() => void) | undefined;
  private resetting = false;

  constructor(options: Drive1541DiskViaOptions) {
    if (
      !Number.isInteger(options.deviceNumber) ||
      options.deviceNumber < 8 ||
      options.deviceNumber > 11
    ) {
      throw new RangeError(`1541 IEC device number must be an integer from 8 through 11.`);
    }
    super(`1541 #${options.deviceNumber} VIA2`, options.debug ?? false);
    this.deviceNumber = options.deviceNumber;
    this.mechanismValue = options.mechanism;
    this.stopObservingByteReady = options.mechanism.observeByteReady(({ asserted }) => {
      // BYTE READY 在原机上是低有效，同时连接 VIA CA1 与 6502 SO；SO 由驱动器 CPU 层订阅。
      this.signalControlLine(MOS_6522_CONTROL_LINE.ca1, !asserted);
    });
    this.applyElectronicResetState();
  }

  get mechanism(): Drive1541Mechanism {
    const mechanism = this.mechanismValue;
    if (!mechanism) throw new Error('1541 disk VIA has not completed construction.');
    return mechanism;
  }

  disconnect(): void {
    const stopObserving = this.stopObservingByteReady;
    if (!stopObserving)
      throw new Error(`1541 #${this.deviceNumber} disk VIA is already disconnected.`);
    stopObserving();
    this.stopObservingByteReady = undefined;
  }

  override reset(): void {
    this.resetting = true;
    super.reset();
    this.resetting = false;
    if (this.mechanismValue) this.applyElectronicResetState();
  }

  protected override readPortAExternalInputs(): number {
    return this.mechanismValue?.dataByte ?? 0xff;
  }

  protected override readPortBExternalInputs(): number {
    const mechanism = this.mechanismValue;
    if (!mechanism) return 0xff;
    return (
      DRIVE_1541_DISK_PORT_B_UNUSED_INPUTS_HIGH |
      (mechanism.writeProtectSensorActive ? 0 : DRIVE_1541_DISK_PORT_B_BIT.writeProtectSensor) |
      (mechanism.syncFound ? 0 : DRIVE_1541_DISK_PORT_B_BIT.syncNotFound)
    );
  }

  protected override onPortAOutputChanged(pins: number): void {
    this.mechanismValue?.setWriteDataByte(pins);
  }

  protected override onPortBOutputChanged(pins: number): void {
    const mechanism = this.mechanismValue;
    if (!mechanism || this.resetting) return;
    mechanism.applyControlState({
      ledOn: (pins & DRIVE_1541_DISK_PORT_B_BIT.led) !== 0,
      motorOn: (pins & DRIVE_1541_DISK_PORT_B_BIT.motor) !== 0,
      speedZone: ((pins & DRIVE_1541_DISK_PORT_B_BIT.speedZoneMask) >>> 5) as Drive1541SpeedZone,
      stepperPhase: pins & DRIVE_1541_DISK_PORT_B_BIT.stepperPhaseMask,
    });
  }

  protected override onControlLineOutputChanged(line: Mos6522ControlLine, high: boolean): void {
    const mechanism = this.mechanismValue;
    if (!mechanism || this.resetting) return;
    if (line === MOS_6522_CONTROL_LINE.ca2) mechanism.setByteReadyEnabled(high);
    if (line === MOS_6522_CONTROL_LINE.cb2) mechanism.setReadMode(high);
  }

  protected override onPortAAccess(): void {
    this.mechanismValue?.acknowledgeByteReady();
  }

  protected override onPortBAccess(): void {
    // 1541 服务手册所示的 VIA2 端口访问会参与 BYTE READY/SOE 应答路径。
    this.mechanismValue?.acknowledgeByteReady();
  }

  private applyElectronicResetState(): void {
    const mechanism = this.mechanism;
    mechanism.setMotorOn(false);
    mechanism.setLedOn(true);
    mechanism.setSpeedZone(0);
    mechanism.setReadMode(true);
    mechanism.setByteReadyEnabled(true);
    mechanism.acknowledgeByteReady();
    this.signalControlLine(MOS_6522_CONTROL_LINE.ca1, true);
  }
}
