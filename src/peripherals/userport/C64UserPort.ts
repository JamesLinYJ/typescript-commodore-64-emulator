// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 User Port 物理信号
//
//   文件:       C64UserPort.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';

export interface C64UserPortHostSignals {
  readonly attentionHigh: boolean;
  readonly cia1SerialClockHigh: boolean;
  readonly cia1SerialDataHigh: boolean;
  readonly cia2SerialClockHigh: boolean;
  readonly cia2SerialDataHigh: boolean;
  readonly portA2High: boolean;
  readonly portB: number;
  readonly portControl2High: boolean;
  readonly resetHigh: boolean;
}

export interface C64UserPortDeviceSignals {
  readonly cia1SerialClockHigh: boolean;
  readonly cia1SerialDataHigh: boolean;
  readonly cia2FlagHigh: boolean;
  readonly cia2SerialClockHigh: boolean;
  readonly cia2SerialDataHigh: boolean;
  readonly portA2High: boolean;
  readonly portB: number;
  readonly resetPulledLow: boolean;
}

export interface C64UserPortHostTransition {
  readonly current: C64UserPortHostSignals;
  readonly previous: C64UserPortHostSignals;
  readonly sequence: number;
}

export interface C64UserPortDeviceTransition {
  readonly current: C64UserPortDeviceSignals;
  readonly previous: C64UserPortDeviceSignals;
  readonly sequence: number;
}

export interface C64UserPortDeviceConnection {
  readonly deviceName: string;
  disconnect(): void;
  observeHostSignals(observer: (event: C64UserPortHostTransition) => void): () => void;
  readHostSignals(): C64UserPortHostSignals;
  setSignals(signals: C64UserPortDeviceSignals): void;
}

const INITIAL_HOST_SIGNALS: C64UserPortHostSignals = {
  attentionHigh: true,
  cia1SerialClockHigh: true,
  cia1SerialDataHigh: true,
  cia2SerialClockHigh: true,
  cia2SerialDataHigh: true,
  portA2High: true,
  portB: 0xff,
  portControl2High: true,
  resetHigh: true,
};

const RELEASED_DEVICE_SIGNALS: C64UserPortDeviceSignals = {
  cia1SerialClockHigh: true,
  cia1SerialDataHigh: true,
  cia2FlagHigh: true,
  cia2SerialClockHigh: true,
  cia2SerialDataHigh: true,
  portA2High: true,
  portB: 0xff,
  resetPulledLow: false,
};

/**
 * User Port 只解析接插件上的数字电平，不解释 RS-232、并口或自定义外设协议。
 * PB0..PB7 与 PA2 采用低电平占优的引脚合成，CNT/SP/FLAG 则保留逐次边沿供 CIA 消费。
 */
export class C64UserPort {
  private hostSignalsValue = INITIAL_HOST_SIGNALS;
  private deviceSignalsValue = RELEASED_DEVICE_SIGNALS;
  private attachedDeviceToken: object | undefined;
  private boardResetHigh = true;
  private hostTransitionSequence = 0;
  private deviceTransitionSequence = 0;
  private readonly hostObservers = new Set<(event: C64UserPortHostTransition) => void>();
  private readonly deviceObservers = new Set<(event: C64UserPortDeviceTransition) => void>();

  get hostSignals(): C64UserPortHostSignals {
    return this.hostSignalsValue;
  }

  get deviceSignals(): C64UserPortDeviceSignals {
    return this.deviceSignalsValue;
  }

  get deviceAttached(): boolean {
    return this.attachedDeviceToken !== undefined;
  }

  attachDevice(deviceName: string): C64UserPortDeviceConnection {
    const normalizedName = deviceName.trim();
    if (normalizedName.length === 0)
      throw new RangeError('User Port device name must not be empty.');
    if (this.attachedDeviceToken) {
      throw new Error('The C64 User Port already has an attached device.');
    }
    const token = {};
    this.attachedDeviceToken = token;
    return {
      deviceName: normalizedName,
      disconnect: () => this.disconnectDevice(token, normalizedName),
      observeHostSignals: (observer) => this.observeHostSignals(token, normalizedName, observer),
      readHostSignals: () => this.readHostSignals(token, normalizedName),
      setSignals: (signals) => this.setDeviceSignals(token, normalizedName, signals),
    };
  }

  observeDeviceSignals(observer: (event: C64UserPortDeviceTransition) => void): () => void {
    this.deviceObservers.add(observer);
    return () => this.deviceObservers.delete(observer);
  }

  setCia1SerialOutputs(clockHigh: boolean, dataHigh: boolean): void {
    this.updateHostSignals({
      ...this.hostSignalsValue,
      cia1SerialClockHigh: clockHigh,
      cia1SerialDataHigh: dataHigh,
    });
  }

  setCia2ParallelOutputs(portA2High: boolean, portB: number, portControl2High: boolean): void {
    this.updateHostSignals({
      ...this.hostSignalsValue,
      portA2High,
      portB: requireByte('CIA2 User Port B output', portB),
      portControl2High,
    });
  }

  setCia2SerialOutputs(clockHigh: boolean, dataHigh: boolean): void {
    this.updateHostSignals({
      ...this.hostSignalsValue,
      cia2SerialClockHigh: clockHigh,
      cia2SerialDataHigh: dataHigh,
    });
  }

  setBoardOutputs(attentionHigh: boolean, resetHigh: boolean): void {
    this.boardResetHigh = resetHigh;
    this.updateHostSignals({
      ...this.hostSignalsValue,
      attentionHigh,
      resetHigh: resetHigh && !this.deviceSignalsValue.resetPulledLow,
    });
  }

  private disconnectDevice(token: object, deviceName: string): void {
    this.requireAttachedToken(token, deviceName);
    this.attachedDeviceToken = undefined;
    this.hostObservers.clear();
    this.updateDeviceSignals(RELEASED_DEVICE_SIGNALS);
  }

  private observeHostSignals(
    token: object,
    deviceName: string,
    observer: (event: C64UserPortHostTransition) => void,
  ): () => void {
    this.requireAttachedToken(token, deviceName);
    this.hostObservers.add(observer);
    return () => this.hostObservers.delete(observer);
  }

  private readHostSignals(token: object, deviceName: string): C64UserPortHostSignals {
    this.requireAttachedToken(token, deviceName);
    return this.hostSignalsValue;
  }

  private setDeviceSignals(
    token: object,
    deviceName: string,
    signals: C64UserPortDeviceSignals,
  ): void {
    this.requireAttachedToken(token, deviceName);
    this.updateDeviceSignals({
      ...signals,
      portB: requireByte(`${deviceName} User Port B input`, signals.portB),
    });
  }

  private updateHostSignals(next: C64UserPortHostSignals): void {
    const previous = this.hostSignalsValue;
    if (sameHostSignals(previous, next)) return;
    this.hostSignalsValue = next;
    this.hostTransitionSequence += 1;
    const event = {
      current: next,
      previous,
      sequence: this.hostTransitionSequence,
    } as const;
    for (const observer of [...this.hostObservers]) observer(event);
  }

  private updateDeviceSignals(next: C64UserPortDeviceSignals): void {
    const previous = this.deviceSignalsValue;
    if (sameDeviceSignals(previous, next)) return;
    this.deviceSignalsValue = next;
    this.updateResolvedResetLine();
    this.deviceTransitionSequence += 1;
    const event = {
      current: next,
      previous,
      sequence: this.deviceTransitionSequence,
    } as const;
    for (const observer of [...this.deviceObservers]) observer(event);
  }

  private updateResolvedResetLine(): void {
    this.updateHostSignals({
      ...this.hostSignalsValue,
      resetHigh: this.boardResetHigh && !this.deviceSignalsValue.resetPulledLow,
    });
  }

  private requireAttachedToken(token: object, deviceName: string): void {
    if (this.attachedDeviceToken !== token) {
      throw new Error(`${deviceName} is no longer attached to the C64 User Port.`);
    }
  }
}

function sameHostSignals(left: C64UserPortHostSignals, right: C64UserPortHostSignals): boolean {
  return (
    left.attentionHigh === right.attentionHigh &&
    left.cia1SerialClockHigh === right.cia1SerialClockHigh &&
    left.cia1SerialDataHigh === right.cia1SerialDataHigh &&
    left.cia2SerialClockHigh === right.cia2SerialClockHigh &&
    left.cia2SerialDataHigh === right.cia2SerialDataHigh &&
    left.portA2High === right.portA2High &&
    left.portB === right.portB &&
    left.portControl2High === right.portControl2High &&
    left.resetHigh === right.resetHigh
  );
}

function sameDeviceSignals(
  left: C64UserPortDeviceSignals,
  right: C64UserPortDeviceSignals,
): boolean {
  return (
    left.cia1SerialClockHigh === right.cia1SerialClockHigh &&
    left.cia1SerialDataHigh === right.cia1SerialDataHigh &&
    left.cia2FlagHigh === right.cia2FlagHigh &&
    left.cia2SerialClockHigh === right.cia2SerialClockHigh &&
    left.cia2SerialDataHigh === right.cia2SerialDataHigh &&
    left.portA2High === right.portA2High &&
    left.portB === right.portB &&
    left.resetPulledLow === right.resetPulledLow
  );
}

function requireByte(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an integer from 0 through 255.`);
  }
  return byte(value);
}
