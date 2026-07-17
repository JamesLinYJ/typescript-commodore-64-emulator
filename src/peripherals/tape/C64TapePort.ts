// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 磁带端口
//
//   文件:       C64TapePort.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export interface C64TapeHostSignals {
  readonly motorActive: boolean;
  readonly writeHigh: boolean;
}

export interface C64TapeHostSignalTransition {
  readonly current: C64TapeHostSignals;
  readonly previous: C64TapeHostSignals;
  readonly sequence: number;
}

export interface C64TapeSenseTransition {
  readonly closed: boolean;
  readonly sequence: number;
}

export interface C64TapeReadPulse {
  readonly sequence: number;
}

export interface C64TapeDevicePort {
  readonly deviceName: string;
  disconnect(): void;
  pulseRead(): void;
  setSenseSwitchClosed(closed: boolean): void;
}

const INITIAL_HOST_SIGNALS: C64TapeHostSignals = {
  motorActive: false,
  writeHigh: true,
};

/** 磁带端口只传递物理线状态，不解析 TAP，也不理解 C1530 的机械按键。 */
export class C64TapePort {
  private hostSignalsValue = INITIAL_HOST_SIGNALS;
  private senseSwitchClosedValue = false;
  private attachedDeviceToken: object | undefined;
  private transitionSequence = 0;
  private readPulseSequence = 0;
  private readonly hostSignalObservers = new Set<(event: C64TapeHostSignalTransition) => void>();
  private readonly senseObservers = new Set<(event: C64TapeSenseTransition) => void>();
  private readonly readPulseObservers = new Set<(event: C64TapeReadPulse) => void>();

  get hostSignals(): C64TapeHostSignals {
    return this.hostSignalsValue;
  }

  get senseSwitchClosed(): boolean {
    return this.senseSwitchClosedValue;
  }

  get deviceAttached(): boolean {
    return this.attachedDeviceToken !== undefined;
  }

  setHostSignals(signals: C64TapeHostSignals): void {
    const previous = this.hostSignalsValue;
    if (previous.motorActive === signals.motorActive && previous.writeHigh === signals.writeHigh) {
      return;
    }
    this.hostSignalsValue = {
      motorActive: signals.motorActive,
      writeHigh: signals.writeHigh,
    };
    this.transitionSequence += 1;
    const event = {
      current: this.hostSignalsValue,
      previous,
      sequence: this.transitionSequence,
    } as const;
    for (const observer of [...this.hostSignalObservers]) observer(event);
  }

  attachDevice(deviceName: string): C64TapeDevicePort {
    if (this.attachedDeviceToken) {
      throw new Error('The C64 tape port already has an attached device.');
    }
    const token = {};
    this.attachedDeviceToken = token;
    return {
      deviceName,
      disconnect: () => this.disconnectDevice(token, deviceName),
      pulseRead: () => this.pulseRead(token, deviceName),
      setSenseSwitchClosed: (closed) => this.setSenseSwitchClosed(token, deviceName, closed),
    };
  }

  observeHostSignals(observer: (event: C64TapeHostSignalTransition) => void): () => void {
    this.hostSignalObservers.add(observer);
    return () => this.hostSignalObservers.delete(observer);
  }

  observeSenseSwitch(observer: (event: C64TapeSenseTransition) => void): () => void {
    this.senseObservers.add(observer);
    return () => this.senseObservers.delete(observer);
  }

  observeReadPulses(observer: (event: C64TapeReadPulse) => void): () => void {
    this.readPulseObservers.add(observer);
    return () => this.readPulseObservers.delete(observer);
  }

  private disconnectDevice(token: object, deviceName: string): void {
    this.requireAttachedToken(token, deviceName);
    if (this.senseSwitchClosedValue) this.setSenseSwitchClosed(token, deviceName, false);
    this.attachedDeviceToken = undefined;
  }

  private setSenseSwitchClosed(token: object, deviceName: string, closed: boolean): void {
    this.requireAttachedToken(token, deviceName);
    if (this.senseSwitchClosedValue === closed) return;
    this.senseSwitchClosedValue = closed;
    this.transitionSequence += 1;
    const event = { closed, sequence: this.transitionSequence } as const;
    for (const observer of [...this.senseObservers]) observer(event);
  }

  private pulseRead(token: object, deviceName: string): void {
    this.requireAttachedToken(token, deviceName);
    this.readPulseSequence += 1;
    const event = { sequence: this.readPulseSequence } as const;
    for (const observer of [...this.readPulseObservers]) observer(event);
  }

  private requireAttachedToken(token: object, deviceName: string): void {
    if (this.attachedDeviceToken !== token) {
      throw new Error(`${deviceName} is no longer attached to the C64 tape port.`);
    }
  }
}
