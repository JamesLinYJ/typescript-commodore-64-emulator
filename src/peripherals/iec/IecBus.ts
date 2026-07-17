// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - IEC 开集电极串行总线
//
//   文件:       IecBus.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export const IEC_LINE = {
  attention: 'attention',
  clock: 'clock',
  data: 'data',
  reset: 'reset',
  serviceRequest: 'serviceRequest',
} as const;

export type IecLine = (typeof IEC_LINE)[keyof typeof IEC_LINE];

const IEC_LINE_BIT = {
  attention: 1 << 0,
  clock: 1 << 1,
  data: 1 << 2,
  reset: 1 << 3,
  serviceRequest: 1 << 4,
} as const;

const ALL_IEC_LINES = [
  IEC_LINE.attention,
  IEC_LINE.clock,
  IEC_LINE.data,
  IEC_LINE.reset,
  IEC_LINE.serviceRequest,
] as const;

export interface IecBusState {
  readonly attentionHigh: boolean;
  readonly clockHigh: boolean;
  readonly dataHigh: boolean;
  readonly resetHigh: boolean;
  readonly serviceRequestHigh: boolean;
}

export interface IecBusTransition {
  readonly changedLines: readonly IecLine[];
  readonly sequence: number;
  readonly state: IecBusState;
}

export type IecBusObserver = (transition: IecBusTransition) => void;

// IEC 使用开集电极驱动：参与者只能把线拉低，没人拉低时由上拉电阻恢复高电平。
// 总线因此聚合所有端口的“拉低”位，而不是让最后一次写入覆盖其他设备。
export class IecBus {
  private readonly driverMasks = new Map<IecBusPort, number>();
  private readonly deviceNames = new Set<string>();
  private readonly observers = new Set<IecBusObserver>();
  private aggregateLowMask = 0;
  private transitionSequence = 0;

  get state(): IecBusState {
    return {
      attentionHigh: this.lineHigh(IEC_LINE.attention),
      clockHigh: this.lineHigh(IEC_LINE.clock),
      dataHigh: this.lineHigh(IEC_LINE.data),
      resetHigh: this.lineHigh(IEC_LINE.reset),
      serviceRequestHigh: this.lineHigh(IEC_LINE.serviceRequest),
    };
  }

  attach(deviceName: string): IecBusPort {
    const normalizedName = deviceName.trim();
    if (normalizedName.length === 0) throw new RangeError('IEC device name must not be empty.');
    if (this.deviceNames.has(normalizedName)) {
      throw new RangeError(`IEC device name "${normalizedName}" is already attached.`);
    }

    const port = new IecBusPort(this, normalizedName);
    this.driverMasks.set(port, 0);
    this.deviceNames.add(normalizedName);
    return port;
  }

  lineHigh(line: IecLine): boolean {
    return (this.aggregateLowMask & lineBit(line)) === 0;
  }

  observe(observer: IecBusObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  updatePort(port: IecBusPort, nextMask: number): void {
    this.requireAttached(port);
    this.driverMasks.set(port, nextMask);
    this.recomputeAggregateState();
  }

  detachPort(port: IecBusPort): void {
    this.requireAttached(port);
    this.driverMasks.delete(port);
    this.deviceNames.delete(port.deviceName);
    this.recomputeAggregateState();
  }

  private recomputeAggregateState(): void {
    let nextMask = 0;
    for (const driverMask of this.driverMasks.values()) nextMask |= driverMask;
    const changedMask = this.aggregateLowMask ^ nextMask;
    if (changedMask === 0) return;

    this.aggregateLowMask = nextMask;
    this.transitionSequence += 1;
    if (this.observers.size === 0) return;

    const changedLines = ALL_IEC_LINES.filter((line) => (changedMask & lineBit(line)) !== 0);
    const transition = {
      changedLines,
      sequence: this.transitionSequence,
      state: this.state,
    } as const;
    for (const observer of this.observers) observer(transition);
  }

  private requireAttached(port: IecBusPort): void {
    if (!this.driverMasks.has(port)) {
      throw new Error(`IEC port "${port.deviceName}" is not attached to this bus.`);
    }
  }
}

export class IecBusPort {
  private lowMask = 0;
  private connected = true;

  constructor(
    private readonly bus: IecBus,
    readonly deviceName: string,
  ) {}

  lineHigh(line: IecLine): boolean {
    this.requireConnected();
    return this.bus.lineHigh(line);
  }

  setPulledLow(line: IecLine, pulledLow: boolean): void {
    this.requireConnected();
    const bit = lineBit(line);
    const nextMask = pulledLow ? this.lowMask | bit : this.lowMask & ~bit;
    this.updateLowMask(nextMask);
  }

  setPulledLowLines(lines: readonly IecLine[]): void {
    this.requireConnected();
    let nextMask = 0;
    for (const line of lines) nextMask |= lineBit(line);
    this.updateLowMask(nextMask);
  }

  releaseAll(): void {
    this.requireConnected();
    if (this.lowMask === 0) return;
    this.lowMask = 0;
    this.bus.updatePort(this, 0);
  }

  disconnect(): void {
    this.requireConnected();
    this.connected = false;
    this.lowMask = 0;
    this.bus.detachPort(this);
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error(`IEC port "${this.deviceName}" has been disconnected.`);
  }

  private updateLowMask(nextMask: number): void {
    if (nextMask === this.lowMask) return;
    this.lowMask = nextMask;
    this.bus.updatePort(this, nextMask);
  }
}

function lineBit(line: IecLine): number {
  switch (line) {
    case IEC_LINE.attention:
      return IEC_LINE_BIT.attention;
    case IEC_LINE.clock:
      return IEC_LINE_BIT.clock;
    case IEC_LINE.data:
      return IEC_LINE_BIT.data;
    case IEC_LINE.reset:
      return IEC_LINE_BIT.reset;
    case IEC_LINE.serviceRequest:
      return IEC_LINE_BIT.serviceRequest;
  }
}
