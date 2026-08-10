// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA2 与 VIC-II、IEC 接线
//
//   文件:       Cia2.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { IecBus, IEC_LINE, type IecBusPort, type IecLine } from '../peripherals/iec/IecBus';
import type { C64UserPort } from '../peripherals/userport/C64UserPort';
import { CIA2_IEC_PORT_A_BIT, CIA2_VIC_BANK } from './ciaRegisters';
import { Mos6526, type Mos6526Options } from './Mos6526';

export interface Cia2Options extends Mos6526Options {
  readonly iecBus?: IecBus;
  readonly userPort?: C64UserPort;
}

const CIA2_USER_PORT_A2_BIT = 1 << 2;

export class Cia2 extends Mos6526 {
  vicBankAddress = 0;
  readonly iecBus: IecBus;
  private hostIecPort: IecBusPort | undefined;
  private serialBusResetAsserted = false;
  private userPortValue: C64UserPort | undefined;

  constructor(options: Cia2Options = {}) {
    const { iecBus, userPort, ...mos6526Options } = options;
    super('CIA2', mos6526Options);
    this.iecBus = iecBus ?? new IecBus();
    this.userPortValue = userPort;
    this.hostIecPort = this.iecBus.attach('C64 CIA2');
    this.updateVicBank(this.portAOutputPins);
    this.updateIecOutputs();
    this.updateUserPortParallelOutputs();
    this.userPortValue?.setCia2SerialOutputs(this.serialClockOutputHigh, this.serialDataOutputHigh);
  }

  protected override onPortAOutputChanged(pins: number): void {
    this.updateVicBank(pins);
    this.updateIecOutputs();
    this.updateUserPortParallelOutputs();
  }

  protected override onPortBOutputChanged(): void {
    this.updateUserPortParallelOutputs();
  }

  protected override onPortControlOutputChanged(): void {
    this.updateUserPortParallelOutputs();
  }

  protected override onSerialOutputChanged(clockHigh: boolean, dataHigh: boolean): void {
    this.userPortValue?.setCia2SerialOutputs(clockHigh, dataHigh);
  }

  protected override readPortAExternalInputs(): number {
    // PA6/PA7 采样 IEC 的开集电极线电平；线被任一设备拉低时相应输入读回 0。
    // PA0..PA5 在这里保持高电平，输出脚仍由 CIA 自己的方向寄存器和锁存器决定。
    const inputs =
      0x3f |
      (this.iecBus.lineHigh(IEC_LINE.clock) ? CIA2_IEC_PORT_A_BIT.clockInput : 0) |
      (this.iecBus.lineHigh(IEC_LINE.data) ? CIA2_IEC_PORT_A_BIT.dataInput : 0);
    const portA2High = this.userPortValue?.deviceSignals.portA2High ?? true;
    return portA2High ? inputs : inputs & ~CIA2_USER_PORT_A2_BIT;
  }

  protected override readPortBExternalInputs(): number {
    return this.userPortValue?.deviceSignals.portB ?? 0xff;
  }

  /** C64 的系统复位电路直接驱动串行口 /RESET，不经过 CIA 端口寄存器。 */
  setSerialBusResetAsserted(asserted: boolean): void {
    if (this.serialBusResetAsserted === asserted) return;
    this.serialBusResetAsserted = asserted;
    this.updateIecOutputs();
  }

  /** 释放 CIA2 在共享 IEC 总线上的主机端口；用于整机实例销毁。 */
  disconnect(): void {
    const port = this.hostIecPort;
    if (!port) return;
    this.hostIecPort = undefined;
    port.disconnect();
    this.userPortValue = undefined;
  }

  private updateVicBank(portAOutput: number): void {
    this.vicBankAddress =
      ((~portAOutput & CIA2_VIC_BANK.selectMask) << CIA2_VIC_BANK.addressShift) & 0xffff;
  }

  private updateIecOutputs(): void {
    const port = this.hostIecPort;
    if (!port) return;

    // PA3..PA5 只有配置为输出且锁存为高时，才通过 7406 反相开集电极驱动器
    // 把 IEC 线拉低；输入模式和输出低电平都释放总线。
    const assertedOutputs = this.portAOutputLatch & this.portADataDirection;
    const pulledLowLines: IecLine[] = [];
    if ((assertedOutputs & CIA2_IEC_PORT_A_BIT.attentionOutput) !== 0) {
      pulledLowLines.push(IEC_LINE.attention);
    }
    if ((assertedOutputs & CIA2_IEC_PORT_A_BIT.clockOutput) !== 0) {
      pulledLowLines.push(IEC_LINE.clock);
    }
    if ((assertedOutputs & CIA2_IEC_PORT_A_BIT.dataOutput) !== 0) {
      pulledLowLines.push(IEC_LINE.data);
    }
    if (this.serialBusResetAsserted) pulledLowLines.push(IEC_LINE.reset);
    port.setPulledLowLines(pulledLowLines);
  }

  private updateUserPortParallelOutputs(): void {
    this.userPortValue?.setCia2ParallelOutputs(
      (this.portAOutputPins & CIA2_USER_PORT_A2_BIT) !== 0,
      this.portBOutputPins,
      this.portControlOutputHigh,
    );
  }
}
