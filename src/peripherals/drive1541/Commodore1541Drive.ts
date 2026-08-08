// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Commodore 1541 驱动器整机
//
//   文件:       Commodore1541Drive.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Cpu6502 } from '../../core/cpu/Cpu6502';
import { D64DiskImage, type D64DiskImageOptions } from '../../media/D64DiskImage';
import { G64DiskImage, type G64DiskImageOptions } from '../../media/G64DiskImage';
import { IEC_LINE, type IecBus } from '../iec/IecBus';
import { Drive1541ClockSynchronizer } from './Drive1541ClockSynchronizer';
import { Drive1541DiskVia } from './Drive1541DiskVia';
import { Drive1541IecVia } from './Drive1541IecVia';
import { Drive1541Machine } from './Drive1541Machine';
import { Drive1541Mechanism, type Drive1541DiskImage } from './Drive1541Mechanism';
import { Drive1541Memory } from './Drive1541Memory';

export interface Commodore1541DriveOptions {
  readonly debug?: boolean;
  readonly deviceNumber?: number;
  readonly iecBus: IecBus;
  readonly rom: Uint8Array;
}

/** 组合独立 6502、两颗 6522、IEC 接口和磁盘机构，不包含任何主机文件系统快捷路径。 */
export class Commodore1541Drive {
  readonly deviceNumber: number;
  readonly mechanism: Drive1541Mechanism;
  readonly iecVia: Drive1541IecVia;
  readonly diskVia: Drive1541DiskVia;
  readonly memory: Drive1541Memory;
  readonly cpu: Cpu6502;
  readonly machine: Drive1541Machine;
  readonly clock: Drive1541ClockSynchronizer;

  private connected = true;
  private readonly stopObservingSerialReset: () => void;

  constructor(options: Commodore1541DriveOptions) {
    const deviceNumber = options.deviceNumber ?? 8;
    this.deviceNumber = deviceNumber;
    this.mechanism = new Drive1541Mechanism();
    this.iecVia = new Drive1541IecVia({
      debug: options.debug ?? false,
      deviceNumber,
      iecBus: options.iecBus,
    });
    this.diskVia = new Drive1541DiskVia({
      debug: options.debug ?? false,
      deviceNumber,
      mechanism: this.mechanism,
    });
    this.memory = new Drive1541Memory(options.rom, {
      diskVia: this.diskVia,
      iecVia: this.iecVia,
    });
    this.cpu = new Cpu6502(this.memory);
    this.machine = new Drive1541Machine(this.cpu, this.memory, this.mechanism);
    this.clock = new Drive1541ClockSynchronizer(this.machine);
    this.stopObservingSerialReset = options.iecBus.observe((transition) => {
      if (transition.changedLines.includes(IEC_LINE.reset) && !transition.state.resetHigh) {
        this.reset();
      }
    });
  }

  mountDisk(image: Drive1541DiskImage): void {
    this.requireConnected();
    this.mechanism.mountDisk(image);
  }

  mountD64(input: ArrayBuffer | Uint8Array, options: D64DiskImageOptions = {}): D64DiskImage {
    const image = new D64DiskImage(input, options);
    this.mountDisk(image);
    return image;
  }

  mountG64(input: ArrayBuffer | Uint8Array, options: G64DiskImageOptions = {}): G64DiskImage {
    const image = new G64DiskImage(input, options);
    this.mountDisk(image);
    return image;
  }

  ejectDisk(): Drive1541DiskImage {
    this.requireConnected();
    return this.mechanism.ejectDisk();
  }

  ejectD64(): D64DiskImage {
    this.requireConnected();
    const image = this.mechanism.mountedDisk;
    if (!(image instanceof D64DiskImage)) {
      throw new Error('The mounted 1541 disk is not a D64 image.');
    }
    this.mechanism.ejectDisk();
    return image;
  }

  ejectG64(): G64DiskImage {
    this.requireConnected();
    const image = this.mechanism.mountedDisk;
    if (!(image instanceof G64DiskImage)) {
      throw new Error('The mounted 1541 disk is not a G64 image.');
    }
    this.mechanism.ejectDisk();
    return image;
  }

  reset(): void {
    this.requireConnected();
    this.mechanism.resetElectronics();
    this.memory.resetHardware();
    this.machine.resetCpu();
    this.clock.resetClock();
  }

  dispose(): void {
    this.requireConnected();
    this.stopObservingSerialReset();
    this.clock.resetClock();
    this.machine.disconnect();
    this.diskVia.disconnect();
    this.iecVia.disconnect();
    this.connected = false;
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error(`Commodore 1541 #${this.deviceNumber} is disconnected.`);
  }
}
