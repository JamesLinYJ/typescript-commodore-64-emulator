// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 双控制端口物理信号
//
//   文件:       C64ControlPorts.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';

export type C64ControlPortNumber = 1 | 2;

export const C64_CONTROL_PORT_DIGITAL_LINE = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  fire: 1 << 4,
} as const;

export const C64_CONTROL_PORT_DIGITAL_LINE_MASK =
  C64_CONTROL_PORT_DIGITAL_LINE.up |
  C64_CONTROL_PORT_DIGITAL_LINE.down |
  C64_CONTROL_PORT_DIGITAL_LINE.left |
  C64_CONTROL_PORT_DIGITAL_LINE.right |
  C64_CONTROL_PORT_DIGITAL_LINE.fire;

export const C64_CONTROL_PORT_PADDLE = {
  /** Commodore 1312 桨式控制器使用的标称满量程电阻。 */
  fullScaleResistanceOhms: 470_000,
  maximumSidValue: 0xff,
} as const;

export const C64_CONTROL_PORT_POT_SELECT = {
  port1: 1 << 6,
  port2: 1 << 7,
} as const;

export interface C64ControlPortDeviceSignals {
  /** 置位表示外设把对应数字引脚接地；未置位表示释放该引脚。 */
  readonly groundedDigitalLines: number;
  /** null 表示 POT X 开路，否则为外设提供的等效电阻。 */
  readonly paddleXResistanceOhms: number | null;
  /** null 表示 POT Y 开路，否则为外设提供的等效电阻。 */
  readonly paddleYResistanceOhms: number | null;
}

export interface C64ControlPortHostSignals {
  /** CIA1 在五根数字线上实际输出的电平，位 1 为高电平。 */
  readonly digitalLinesHigh: number;
}

export interface C64ControlPortDeviceTransition {
  readonly current: C64ControlPortDeviceSignals;
  readonly port: C64ControlPortNumber;
  readonly previous: C64ControlPortDeviceSignals;
  readonly sequence: number;
}

export interface C64ControlPortHostTransition {
  readonly current: C64ControlPortHostSignals;
  readonly port: C64ControlPortNumber;
  readonly previous: C64ControlPortHostSignals;
  readonly sequence: number;
}

export interface C64ControlPortDeviceConnection {
  readonly deviceName: string;
  readonly port: C64ControlPortNumber;
  disconnect(): void;
  observeHostSignals(observer: (event: C64ControlPortHostTransition) => void): () => void;
  readHostSignals(): C64ControlPortHostSignals;
  setSignals(signals: C64ControlPortDeviceSignals): void;
}

export interface SidPaddleInputs {
  readonly x: number;
  readonly y: number;
}

export interface SidPaddleInputTransition {
  readonly current: SidPaddleInputs;
  readonly previous: SidPaddleInputs;
  readonly sequence: number;
}

const RELEASED_DEVICE_SIGNALS: C64ControlPortDeviceSignals = {
  groundedDigitalLines: 0,
  paddleXResistanceOhms: null,
  paddleYResistanceOhms: null,
};

const INITIAL_HOST_SIGNALS: C64ControlPortHostSignals = {
  digitalLinesHigh: C64_CONTROL_PORT_DIGITAL_LINE_MASK,
};

/**
 * 单个 DE-9 控制端口只负责连接器电气状态，不解释操纵杆、鼠标或光笔协议。
 * 数字线采用接地优先的合成方式，POT 线保存外设对 +5V 呈现的等效电阻。
 */
export class C64ControlPort {
  private deviceSignalsValue = RELEASED_DEVICE_SIGNALS;
  private hostSignalsValue = INITIAL_HOST_SIGNALS;
  private attachedDeviceToken: object | undefined;
  private transitionSequence = 0;
  private readonly deviceObservers = new Set<(event: C64ControlPortDeviceTransition) => void>();
  private readonly hostObservers = new Set<(event: C64ControlPortHostTransition) => void>();

  constructor(readonly portNumber: C64ControlPortNumber) {}

  get deviceAttached(): boolean {
    return this.attachedDeviceToken !== undefined;
  }

  get deviceSignals(): C64ControlPortDeviceSignals {
    return this.deviceSignalsValue;
  }

  get hostSignals(): C64ControlPortHostSignals {
    return this.hostSignalsValue;
  }

  get digitalInputPins(): number {
    return byte(~this.deviceSignalsValue.groundedDigitalLines);
  }

  attachDevice(deviceName: string): C64ControlPortDeviceConnection {
    const normalizedName = deviceName.trim();
    if (normalizedName.length === 0) {
      throw new RangeError('Control-port device name must not be empty.');
    }
    if (this.attachedDeviceToken) {
      throw new Error(`C64 control port ${this.portNumber} already has an attached device.`);
    }

    const token = {};
    this.attachedDeviceToken = token;
    return {
      deviceName: normalizedName,
      port: this.portNumber,
      disconnect: () => this.disconnectDevice(token, normalizedName),
      observeHostSignals: (observer) => this.observeHostSignals(token, normalizedName, observer),
      readHostSignals: () => this.readHostSignals(token, normalizedName),
      setSignals: (signals) => this.setDeviceSignals(token, normalizedName, signals),
    };
  }

  observeDeviceSignals(observer: (event: C64ControlPortDeviceTransition) => void): () => void {
    this.deviceObservers.add(observer);
    return () => this.deviceObservers.delete(observer);
  }

  setHostDigitalLines(digitalLinesHigh: number): void {
    const next: C64ControlPortHostSignals = {
      digitalLinesHigh: requireDigitalLineMask('CIA1 control-port output', digitalLinesHigh),
    };
    const previous = this.hostSignalsValue;
    if (previous.digitalLinesHigh === next.digitalLinesHigh) return;
    this.hostSignalsValue = next;
    this.transitionSequence += 1;
    const event = {
      current: next,
      port: this.portNumber,
      previous,
      sequence: this.transitionSequence,
    } as const;
    for (const observer of [...this.hostObservers]) observer(event);
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
    observer: (event: C64ControlPortHostTransition) => void,
  ): () => void {
    this.requireAttachedToken(token, deviceName);
    this.hostObservers.add(observer);
    return () => this.hostObservers.delete(observer);
  }

  private readHostSignals(token: object, deviceName: string): C64ControlPortHostSignals {
    this.requireAttachedToken(token, deviceName);
    return this.hostSignalsValue;
  }

  private setDeviceSignals(
    token: object,
    deviceName: string,
    signals: C64ControlPortDeviceSignals,
  ): void {
    this.requireAttachedToken(token, deviceName);
    this.updateDeviceSignals({
      groundedDigitalLines: requireDigitalLineMask(
        `${deviceName} grounded control-port lines`,
        signals.groundedDigitalLines,
      ),
      paddleXResistanceOhms: requireResistance(
        `${deviceName} POT X resistance`,
        signals.paddleXResistanceOhms,
      ),
      paddleYResistanceOhms: requireResistance(
        `${deviceName} POT Y resistance`,
        signals.paddleYResistanceOhms,
      ),
    });
  }

  private updateDeviceSignals(next: C64ControlPortDeviceSignals): void {
    const previous = this.deviceSignalsValue;
    if (sameDeviceSignals(previous, next)) return;
    this.deviceSignalsValue = next;
    this.transitionSequence += 1;
    const event = {
      current: next,
      port: this.portNumber,
      previous,
      sequence: this.transitionSequence,
    } as const;
    for (const observer of [...this.deviceObservers]) observer(event);
  }

  private requireAttachedToken(token: object, deviceName: string): void {
    if (this.attachedDeviceToken !== token) {
      throw new Error(
        `${deviceName} is no longer attached to C64 control port ${this.portNumber}.`,
      );
    }
  }
}

/**
 * 主板上的双控制口互连：端口 2 接 CIA1 PA，端口 1 接 CIA1 PB；PA6/PA7
 * 再驱动 4066 模拟开关，把选中的 POT 电阻送到 SID 的 X/Y 转换器。
 */
export class C64ControlPorts {
  readonly port1 = new C64ControlPort(1);
  readonly port2 = new C64ControlPort(2);

  private cia1PortAOutputPins = 0xff;
  private cia1PortBOutputPins = 0xff;
  private paddleInputsValue: SidPaddleInputs = { x: 0xff, y: 0xff };
  private paddleTransitionSequence = 0;
  private readonly deviceObservers = new Set<(event: C64ControlPortDeviceTransition) => void>();
  private readonly paddleObservers = new Set<(event: SidPaddleInputTransition) => void>();

  constructor() {
    this.port1.observeDeviceSignals((event) => this.handleDeviceTransition(event));
    this.port2.observeDeviceSignals((event) => this.handleDeviceTransition(event));
  }

  get portAExternalInputPins(): number {
    return this.port2.digitalInputPins;
  }

  get portBExternalInputPins(): number {
    return this.port1.digitalInputPins;
  }

  get paddleInputs(): SidPaddleInputs {
    return this.paddleInputsValue;
  }

  observeDeviceSignals(observer: (event: C64ControlPortDeviceTransition) => void): () => void {
    this.deviceObservers.add(observer);
    return () => this.deviceObservers.delete(observer);
  }

  observePaddleInputs(observer: (event: SidPaddleInputTransition) => void): () => void {
    this.paddleObservers.add(observer);
    return () => this.paddleObservers.delete(observer);
  }

  setCia1OutputPins(portA: number, portB: number): void {
    this.cia1PortAOutputPins = byte(portA);
    this.cia1PortBOutputPins = byte(portB);
    this.port2.setHostDigitalLines(this.cia1PortAOutputPins & C64_CONTROL_PORT_DIGITAL_LINE_MASK);
    this.port1.setHostDigitalLines(this.cia1PortBOutputPins & C64_CONTROL_PORT_DIGITAL_LINE_MASK);
    this.synchronizePaddleInputs();
  }

  private handleDeviceTransition(event: C64ControlPortDeviceTransition): void {
    for (const observer of [...this.deviceObservers]) observer(event);
    this.synchronizePaddleInputs();
  }

  private synchronizePaddleInputs(): void {
    const port1Selected = (this.cia1PortAOutputPins & C64_CONTROL_PORT_POT_SELECT.port1) !== 0;
    const port2Selected = (this.cia1PortAOutputPins & C64_CONTROL_PORT_POT_SELECT.port2) !== 0;
    const selectedSignals = [
      ...(port1Selected ? [this.port1.deviceSignals] : []),
      ...(port2Selected ? [this.port2.deviceSignals] : []),
    ];
    const next = {
      x: resistanceToSidValue(
        parallelResistance(selectedSignals.map((signals) => signals.paddleXResistanceOhms)),
      ),
      y: resistanceToSidValue(
        parallelResistance(selectedSignals.map((signals) => signals.paddleYResistanceOhms)),
      ),
    } as const;
    const previous = this.paddleInputsValue;
    if (previous.x === next.x && previous.y === next.y) return;
    this.paddleInputsValue = next;
    this.paddleTransitionSequence += 1;
    const event = {
      current: next,
      previous,
      sequence: this.paddleTransitionSequence,
    } as const;
    for (const observer of [...this.paddleObservers]) observer(event);
  }
}

function sameDeviceSignals(
  left: C64ControlPortDeviceSignals,
  right: C64ControlPortDeviceSignals,
): boolean {
  return (
    left.groundedDigitalLines === right.groundedDigitalLines &&
    left.paddleXResistanceOhms === right.paddleXResistanceOhms &&
    left.paddleYResistanceOhms === right.paddleYResistanceOhms
  );
}

function parallelResistance(values: readonly (number | null)[]): number | null {
  const connected = values.filter((value): value is number => value !== null);
  if (connected.length === 0) return null;
  if (connected.length === 1) return connected[0] ?? null;
  if (connected.some((value) => value === 0)) return 0;

  const reciprocalSum = connected.reduce((sum, value) => sum + 1 / value, 0);
  return 1 / reciprocalSum;
}

function resistanceToSidValue(resistanceOhms: number | null): number {
  if (resistanceOhms === null) return C64_CONTROL_PORT_PADDLE.maximumSidValue;
  if (resistanceOhms >= C64_CONTROL_PORT_PADDLE.fullScaleResistanceOhms) {
    return C64_CONTROL_PORT_PADDLE.maximumSidValue;
  }
  const scaled = Math.round(
    (resistanceOhms * C64_CONTROL_PORT_PADDLE.maximumSidValue) /
      C64_CONTROL_PORT_PADDLE.fullScaleResistanceOhms,
  );
  return Math.min(C64_CONTROL_PORT_PADDLE.maximumSidValue, scaled);
}

function requireDigitalLineMask(name: string, value: number): number {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    (value & ~C64_CONTROL_PORT_DIGITAL_LINE_MASK) !== 0
  ) {
    throw new RangeError(`${name} must contain only the five control-port digital-line bits.`);
  }
  return value;
}

function requireResistance(name: string, value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number of ohms or null for open.`);
  }
  return value;
}
