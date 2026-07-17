// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 IEC 接口 VIA
//
//   文件:       Drive1541IecVia.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Mos6522 } from '../../devices/Mos6522';
import { MOS_6522_CONTROL_LINE } from '../../devices/Mos6522Registers';
import {
  IecBus,
  IEC_LINE,
  type IecBusPort,
  type IecBusTransition,
  type IecLine,
} from '../iec/IecBus';

export const DRIVE_1541_IEC_PORT_B_BIT = {
  dataInput: 1 << 0,
  dataOutput: 1 << 1,
  clockInput: 1 << 2,
  clockOutput: 1 << 3,
  attentionAcknowledgeOutput: 1 << 4,
  deviceAddressMask: 0x60,
  attentionInput: 1 << 7,
} as const;

export interface Drive1541IecViaOptions {
  readonly debug?: boolean;
  readonly deviceNumber: number;
  readonly iecBus: IecBus;
}

export class Drive1541IecVia extends Mos6522 {
  readonly deviceNumber: number;
  readonly iecBus: IecBus;

  private iecPort: IecBusPort | undefined;
  private stopObservingBus: (() => void) | undefined;

  constructor(options: Drive1541IecViaOptions) {
    if (
      !Number.isInteger(options.deviceNumber) ||
      options.deviceNumber < 8 ||
      options.deviceNumber > 11
    ) {
      throw new RangeError(`1541 IEC device number must be an integer from 8 through 11.`);
    }
    super(`1541 #${options.deviceNumber} VIA1`, options.debug ?? false);
    this.deviceNumber = options.deviceNumber;
    this.iecBus = options.iecBus;
    this.iecPort = this.iecBus.attach(`Commodore 1541 #${this.deviceNumber} VIA1`);
    this.stopObservingBus = this.iecBus.observe((transition) =>
      this.handleBusTransition(transition),
    );
    this.signalAttentionToCa1(this.iecBus.state.attentionHigh);
    this.updateIecOutputs();
  }

  disconnect(): void {
    const port = this.iecPort;
    if (!port) throw new Error(`1541 #${this.deviceNumber} IEC VIA is already disconnected.`);
    this.stopObservingBus?.();
    this.stopObservingBus = undefined;
    port.disconnect();
    this.iecPort = undefined;
  }

  protected override readPortBExternalInputs(): number {
    const state = this.iecBus.state;
    const addressSwitches = (this.deviceNumber - 8) << 5;
    return (
      DRIVE_1541_IEC_PORT_B_BIT.dataOutput |
      DRIVE_1541_IEC_PORT_B_BIT.clockOutput |
      DRIVE_1541_IEC_PORT_B_BIT.attentionAcknowledgeOutput |
      addressSwitches |
      (state.dataHigh ? 0 : DRIVE_1541_IEC_PORT_B_BIT.dataInput) |
      (state.clockHigh ? 0 : DRIVE_1541_IEC_PORT_B_BIT.clockInput) |
      (state.attentionHigh ? 0 : DRIVE_1541_IEC_PORT_B_BIT.attentionInput)
    );
  }

  protected override onPortBOutputChanged(): void {
    this.updateIecOutputs();
  }

  private handleBusTransition(transition: IecBusTransition): void {
    if (transition.changedLines.includes(IEC_LINE.attention)) {
      this.signalAttentionToCa1(transition.state.attentionHigh);
    }
    this.updateIecOutputs();
  }

  private signalAttentionToCa1(attentionHigh: boolean): void {
    // 1541 把 IEC ATN 经过反相器接到 VIA1 CA1。DOS ROM 在初始化时把 PCR 写成 $01，
    // 因而主机断言低有效 ATN 必须在 CA1 上形成上升沿；直接传递物理总线电平会让
    // ROM 永远收不到 ATN IRQ，并把 C64 卡在 KERNAL 串行发送握手中。
    this.signalControlLine(MOS_6522_CONTROL_LINE.ca1, !attentionHigh);
  }

  private updateIecOutputs(): void {
    const port = this.iecPort;
    if (!port) return;

    const outputLatch = this.portBOutputLatch;
    const outputDirection = this.portBDataDirection;
    const assertedOutputs = outputLatch & outputDirection;
    const pulledLowLines: IecLine[] = [];
    if ((assertedOutputs & DRIVE_1541_IEC_PORT_B_BIT.clockOutput) !== 0) {
      pulledLowLines.push(IEC_LINE.clock);
    }

    // PB1/PB3 的高电平经过 7406 后把 DATA/CLOCK 拉低。DATA 还受 ATNA 门控制：
    // 当 PB4 与总线 ATN 电平相等时，门电路自动拉低 DATA，DOS ROM 因而只需改变
    // ATNA 就能确认或撤销 ATN 握手，不需要软件逐次重写 DATA OUT。
    const dataOutputAsserted = (assertedOutputs & DRIVE_1541_IEC_PORT_B_BIT.dataOutput) !== 0;
    const attentionAcknowledgeIsOutput =
      (outputDirection & DRIVE_1541_IEC_PORT_B_BIT.attentionAcknowledgeOutput) !== 0;
    const attentionAcknowledgeHigh =
      (outputLatch & DRIVE_1541_IEC_PORT_B_BIT.attentionAcknowledgeOutput) !== 0;
    const attentionGateAsserted =
      attentionAcknowledgeIsOutput && attentionAcknowledgeHigh === this.iecBus.state.attentionHigh;
    if (dataOutputAsserted || attentionGateAsserted) {
      pulledLowLines.push(IEC_LINE.data);
    }
    port.setPulledLowLines(pulledLowLines);
  }
}
