// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 内存与设备总线
//
//   文件:       C64Memory.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { Cia1 } from '../../devices/Cia1';
import { Cia2 } from '../../devices/Cia2';
import { DEFAULT_MOS_6526_MODEL, type Mos6526Model } from '../../devices/Mos6526Model';
import { RestoreKeyNmiCircuit } from '../../devices/RestoreKeyNmiCircuit';
import { Sid } from '../../devices/Sid';
import type { SidModel } from '../../devices/SidModel';
import { VicII } from '../../devices/VicII';
import { VIC_MEMORY_LAYOUT, type VicMemoryBus } from '../../devices/VicMemoryBus';
import { C64ControlPorts } from '../../peripherals/control/C64ControlPorts';
import { IecBus, IEC_LINE } from '../../peripherals/iec/IecBus';
import { Commodore1530Datasette } from '../../peripherals/tape/Commodore1530Datasette';
import { C64TapePort } from '../../peripherals/tape/C64TapePort';
import { C64UserPort, type C64UserPortDeviceSignals } from '../../peripherals/userport/C64UserPort';
import { byte, hex, word } from '../../shared/numbers';
import {
  type C64CartridgePort,
  type C64CartridgeReadResult,
  DisconnectedC64CartridgePort,
} from './C64CartridgePort';
import {
  C64Pla,
  C64_PLA_TARGET,
  c64PlaConfigurationCode,
  type C64PlaInputs,
  type C64PlaTarget,
} from './C64Pla';
import type { MemoryBus } from './MemoryBus';
import { C64_MEMORY_LAYOUT, PROCESSOR_PORT_BIT } from './memoryLayout';
import { ProcessorPort6510 } from './ProcessorPort6510';

export interface C64Firmware {
  readonly basic: Uint8Array;
  readonly character: Uint8Array;
  readonly kernal: Uint8Array;
}

export interface C64CiaModels {
  readonly cia1?: Mos6526Model;
  readonly cia2?: Mos6526Model;
}

export interface C64MemoryOptions {
  readonly cartridge?: C64CartridgePort;
  readonly ciaModels?: C64CiaModels;
  readonly debug?: boolean;
  readonly iecBus?: IecBus;
  readonly sidModel?: SidModel;
}

export interface MemoryWriteEvent {
  readonly address: number;
  readonly value: number;
}

export type MemoryWriteObserver = (event: MemoryWriteEvent) => void;
export type CpuBusAccessKind = 'read' | 'write';
export interface CpuBusCycleObserver {
  completeCpuBusCycle(): void;
  startCpuBusCycle(kind: CpuBusAccessKind, address: number): void;
}

export class C64Memory implements MemoryBus, VicMemoryBus {
  readonly ram = new Uint8Array(C64_MEMORY_LAYOUT.addressSpace.size);
  readonly colorRam = new Uint8Array(C64_MEMORY_LAYOUT.colorRam.size);
  readonly vic: VicII;
  readonly controlPorts = new C64ControlPorts();
  readonly userPort = new C64UserPort();
  readonly cia1: Cia1;
  readonly cia2: Cia2;
  readonly restoreKey = new RestoreKeyNmiCircuit();
  readonly sid: Sid;
  readonly processorPort = new ProcessorPort6510();
  readonly pla: C64Pla;
  readonly iecBus: IecBus;
  readonly tapePort: C64TapePort;
  readonly datasette: Commodore1530Datasette;

  private readonly writeObservers = new Set<MemoryWriteObserver>();
  private cartridgePort: C64CartridgePort;
  private cpuBusCycleObserver: CpuBusCycleObserver | undefined;
  private cpuDataBusLatch = 0xff;
  private tapeReadLineHigh = true;

  constructor(
    private readonly firmware: C64Firmware,
    options: C64MemoryOptions = {},
  ) {
    this.assertFirmwareSize('KERNAL', firmware.kernal, C64_MEMORY_LAYOUT.kernalRom.size);
    this.assertFirmwareSize('BASIC', firmware.basic, C64_MEMORY_LAYOUT.basicRom.size);
    this.assertFirmwareSize('character', firmware.character, C64_MEMORY_LAYOUT.characterRom.size);

    const debug = options.debug ?? false;
    this.vic = new VicII(debug);
    this.cia1 = new Cia1({
      controlPorts: this.controlPorts,
      debug,
      lightPenInput: this.vic,
      model: options.ciaModels?.cia1 ?? DEFAULT_MOS_6526_MODEL,
      userPort: this.userPort,
    });
    this.iecBus = options.iecBus ?? new IecBus();
    this.iecBus.observe((transition) => {
      if (transition.changedLines.includes(IEC_LINE.serviceRequest)) {
        this.synchronizeCia1FlagPin();
      }
      if (
        transition.changedLines.includes(IEC_LINE.attention) ||
        transition.changedLines.includes(IEC_LINE.reset)
      ) {
        this.synchronizeUserPortBoardSignals();
      }
    });
    this.cia2 = new Cia2({
      debug,
      iecBus: this.iecBus,
      model: options.ciaModels?.cia2 ?? DEFAULT_MOS_6526_MODEL,
      userPort: this.userPort,
    });
    this.userPort.observeDeviceSignals(({ current, previous }) => {
      this.synchronizeUserPortDeviceSignals(current, previous);
    });
    this.synchronizeUserPortDeviceSignals(this.userPort.deviceSignals, this.userPort.deviceSignals);
    this.synchronizeUserPortBoardSignals();
    this.tapePort = new C64TapePort();
    this.datasette = new Commodore1530Datasette(this.tapePort);
    this.processorPort.observeOutputPins(() => this.synchronizeTapeHostSignals());
    this.tapePort.observeSenseSwitch(({ closed }) => this.synchronizeTapeSense(closed));
    this.tapePort.observeReadPulses(() => this.pulseTapeReadLine());
    this.synchronizeTapeHostSignals();
    this.synchronizeTapeSense(this.tapePort.senseSwitchClosed);
    this.sid = new Sid(debug, options.sidModel ? { model: options.sidModel } : {});
    this.controlPorts.observePaddleInputs(() => this.synchronizeSidPaddleInputs());
    this.synchronizeSidPaddleInputs();
    this.cartridgePort = options.cartridge ?? new DisconnectedC64CartridgePort();
    this.cartridgePort.reset();
    this.pla = new C64Pla(this.currentPlaInputs());
    this.resetProcessorPort();
  }

  read(address: number): number {
    const normalized = word(address);
    const observer = this.cpuBusCycleObserver;
    observer?.startCpuBusCycle('read', normalized);
    try {
      if (normalized === C64_MEMORY_LAYOUT.processorPort.directionRegister) {
        return this.latchCpuDataBus(this.processorPort.directionRegister);
      }
      if (normalized === C64_MEMORY_LAYOUT.processorPort.bankingRegister) {
        return this.latchCpuDataBus(this.processorPort.dataRegister);
      }
      this.synchronizePlaConfiguration();
      return this.latchCpuDataBus(this.readPlaTarget(this.pla.readTarget(normalized), normalized));
    } finally {
      observer?.completeCpuBusCycle();
    }
  }

  readWord(address: number): number {
    const normalized = word(address);
    return this.read(normalized) | (this.read(word(normalized + 1)) << 8);
  }

  get cartridge(): C64CartridgePort {
    return this.cartridgePort;
  }

  // AEC 尚未拉低时，VIC-II 的 C-access 会观察 6510 当前驱动的数据总线。
  // 该锁存器保存最近一次 CPU 读写周期的八位值，不与 VIC 自己的 φ1 锁存器混用。
  get cpuDataBusValue(): number {
    return this.cpuDataBusLatch;
  }

  insertCartridge(cartridge: C64CartridgePort): void {
    this.cartridgePort = cartridge;
    this.cartridgePort.reset();
    this.pla.configure(this.currentPlaInputs());
  }

  ejectCartridge(): void {
    this.cartridgePort = new DisconnectedC64CartridgePort();
    this.pla.configure(this.currentPlaInputs());
  }

  readStack(stackPointer: number): number {
    const address = C64_MEMORY_LAYOUT.stack.start + byte(stackPointer);
    const observer = this.cpuBusCycleObserver;
    observer?.startCpuBusCycle('read', address);
    try {
      return this.latchCpuDataBus(this.ram[address]!);
    } finally {
      observer?.completeCpuBusCycle();
    }
  }

  readVicByte(addressInBank: number): number {
    const localAddress = word(addressInBank) & VIC_MEMORY_LAYOUT.bank.addressMask;
    const physicalAddress = this.cia2.vicBankAddress | localAddress;
    if (
      (physicalAddress & VIC_MEMORY_LAYOUT.characterRomWindow.addressMask) ===
      VIC_MEMORY_LAYOUT.characterRomWindow.addressValue
    ) {
      return (
        this.firmware.character[
          physicalAddress & VIC_MEMORY_LAYOUT.characterRomWindow.localOffsetMask
        ] ?? 0
      );
    }
    return this.ram[physicalAddress] ?? 0;
  }

  readVicColor(index: number): number {
    return this.colorRam[index & VIC_MEMORY_LAYOUT.colorRam.addressMask] ?? 0;
  }

  copyRam(address: number, length: number): Uint8Array {
    const start = word(address);
    return this.ram.slice(
      start,
      Math.min(C64_MEMORY_LAYOUT.addressSpace.size, start + Math.max(0, length)),
    );
  }

  /**
   * 把宿主提供的镜像直接注入物理 RAM，不经过 PLA、I/O 寄存器或 CPU 总线观察器。
   * 该入口只服务于明确选择的 PRG RAM-injection 工作流；正常硬件访问仍必须走 read/write。
   */
  injectRamImage(address: number, image: Uint8Array): void {
    if (!Number.isInteger(address) || address < 0) {
      throw new RangeError(
        `RAM injection address must be a non-negative integer; received ${address}.`,
      );
    }
    const endAddress = address + image.length;
    if (endAddress > C64_MEMORY_LAYOUT.addressSpace.size) {
      throw new RangeError(
        `RAM injection range $${address.toString(16)}..$${(endAddress - 1).toString(16)} exceeds the 64 KiB address space.`,
      );
    }
    this.ram.set(image, address);
  }

  write(address: number, value: number): void {
    const normalized = word(address);
    const normalizedValue = byte(value);
    this.cpuDataBusLatch = normalizedValue;
    const observer = this.cpuBusCycleObserver;
    observer?.startCpuBusCycle('write', normalized);
    try {
      if (normalized === C64_MEMORY_LAYOUT.processorPort.directionRegister) {
        this.processorPort.writeDirection(normalizedValue);
        this.ram[normalized] = normalizedValue;
        this.synchronizePlaConfiguration();
        this.notifyWriteObservers(normalized, normalizedValue);
        return;
      }
      if (normalized === C64_MEMORY_LAYOUT.processorPort.bankingRegister) {
        this.processorPort.writeData(normalizedValue);
        this.ram[normalized] = normalizedValue;
        this.synchronizePlaConfiguration();
        this.notifyWriteObservers(normalized, normalizedValue);
        return;
      }
      this.synchronizePlaConfiguration();
      this.writePlaTarget(this.pla.writeTarget(normalized), normalized, normalizedValue);
      this.notifyWriteObservers(normalized, normalizedValue);
    } finally {
      observer?.completeCpuBusCycle();
    }
  }

  observeWrites(observer: MemoryWriteObserver): () => void {
    this.writeObservers.add(observer);
    return () => this.writeObservers.delete(observer);
  }

  setCpuBusCycleObserver(
    observer: CpuBusCycleObserver | undefined,
  ): CpuBusCycleObserver | undefined {
    const previous = this.cpuBusCycleObserver;
    this.cpuBusCycleObserver = observer;
    return previous;
  }

  writeWord(address: number, value: number): void {
    const normalized = word(address);
    this.write(normalized, value);
    this.write(word(normalized + 1), value >> 8);
  }

  writeStack(stackPointer: number, value: number): void {
    const address = C64_MEMORY_LAYOUT.stack.start + byte(stackPointer);
    const normalizedValue = byte(value);
    this.cpuDataBusLatch = normalizedValue;
    const observer = this.cpuBusCycleObserver;
    observer?.startCpuBusCycle('write', address);
    try {
      this.ram[address] = normalizedValue;
    } finally {
      observer?.completeCpuBusCycle();
    }
  }

  resetProcessorPort(): void {
    const { processorPort } = C64_MEMORY_LAYOUT;
    this.processorPort.reset();
    this.ram[processorPort.directionRegister] = this.processorPort.directionRegister;
    this.ram[processorPort.bankingRegister] = this.processorPort.outputLatch;
    this.pla.configure(this.currentPlaInputs());
  }

  resetHardware(): void {
    // 系统 /RESET 同时送往串行口；总线设备在下降沿同步复位自身电子部分。
    this.cia2.setSerialBusResetAsserted(true);
    this.cpuDataBusLatch = 0xff;
    this.cartridgePort.reset();
    this.resetProcessorPort();
    this.restoreKey.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.sid.reset();
    this.synchronizeSidPaddleInputs();
    this.vic.reset();
    this.cia2.setSerialBusResetAsserted(false);
  }

  dump(address: number, length: number, bytesPerLine = 8): string {
    const lines: string[] = [];
    for (let offset = 0; offset < length; offset += bytesPerLine) {
      const lineAddress = word(address + offset);
      const values: string[] = [];
      for (let index = 0; index < Math.min(bytesPerLine, length - offset); index += 1) {
        values.push(hex(this.read(lineAddress + index)));
      }
      lines.push(`${hex(lineAddress, 4)}: ${values.join(' ')}`);
    }
    return lines.join('\n');
  }

  private currentPlaInputs(): C64PlaInputs {
    return {
      exromLineHigh: this.cartridgePort.exromLineHigh,
      gameLineHigh: this.cartridgePort.gameLineHigh,
      processorPort: this.processorPort.bankingConfiguration,
    };
  }

  private latchCpuDataBus(value: number): number {
    this.cpuDataBusLatch = byte(value);
    return this.cpuDataBusLatch;
  }

  private synchronizePlaConfiguration(): void {
    const inputs = this.currentPlaInputs();
    if (this.pla.configurationCode !== c64PlaConfigurationCode(inputs)) {
      this.pla.configure(inputs);
    }
  }

  private readPlaTarget(target: C64PlaTarget, address: number): number {
    switch (target) {
      case C64_PLA_TARGET.ram:
        return this.ram[address]!;
      case C64_PLA_TARGET.basicRom:
        return this.readFirmwareByte(
          'BASIC',
          this.firmware.basic,
          address - C64_MEMORY_LAYOUT.basicRom.start,
        );
      case C64_PLA_TARGET.kernalRom:
        return this.readFirmwareByte(
          'KERNAL',
          this.firmware.kernal,
          address - C64_MEMORY_LAYOUT.kernalRom.start,
        );
      case C64_PLA_TARGET.characterRom:
        return this.readFirmwareByte(
          'character',
          this.firmware.character,
          address - C64_MEMORY_LAYOUT.characterRom.start,
        );
      case C64_PLA_TARGET.io:
        return this.readIo(address);
      case C64_PLA_TARGET.cartridgeLow:
        return this.resolveCartridgeRead(this.cartridgePort.readRomLow(address), address, 'ROML');
      case C64_PLA_TARGET.cartridgeHigh:
        return this.resolveCartridgeRead(this.cartridgePort.readRomHigh(address), address, 'ROMH');
      case C64_PLA_TARGET.openBus:
        return this.vic.phi1DataBusValue;
    }
  }

  private writePlaTarget(target: C64PlaTarget, address: number, value: number): void {
    switch (target) {
      case C64_PLA_TARGET.ram:
      case C64_PLA_TARGET.basicRom:
      case C64_PLA_TARGET.kernalRom:
      case C64_PLA_TARGET.characterRom:
        this.ram[address] = value;
        return;
      case C64_PLA_TARGET.io:
        this.writeIo(address, value);
        return;
      case C64_PLA_TARGET.cartridgeLow:
        this.cartridgePort.writeRomLow(address, value);
        return;
      case C64_PLA_TARGET.cartridgeHigh:
        this.cartridgePort.writeRomHigh(address, value);
        return;
      case C64_PLA_TARGET.openBus:
        // Ultimax 未连接地址没有 RAM 或外设响应，写周期不会改变任何存储单元。
        return;
    }
  }

  private readIo(address: number): number {
    const page = address >>> 8;
    if (page >= C64_MEMORY_LAYOUT.vic.firstPage && page <= C64_MEMORY_LAYOUT.vic.lastPage) {
      return this.vic.read(address);
    }
    if (page >= C64_MEMORY_LAYOUT.sid.firstPage && page <= C64_MEMORY_LAYOUT.sid.lastPage) {
      return this.sid.read(address);
    }
    if (
      page >= C64_MEMORY_LAYOUT.colorRam.firstPage &&
      page <= C64_MEMORY_LAYOUT.colorRam.lastPage
    ) {
      const color = this.colorRam[address - C64_MEMORY_LAYOUT.colorRam.start];
      if (color === undefined) {
        throw new RangeError(`Color RAM address ${hex(address, 4)} is outside its 1 KiB window.`);
      }
      return color | (this.vic.phi1DataBusValue & 0xf0);
    }
    if (page === C64_MEMORY_LAYOUT.cia1.firstPage) return this.cia1.read(address);
    if (page === C64_MEMORY_LAYOUT.cia2.firstPage) return this.cia2.read(address);
    if (page === C64_MEMORY_LAYOUT.cartridgeIo1.firstPage) {
      return this.resolveCartridgeRead(this.cartridgePort.readIo1(address), address, 'IO1');
    }
    if (page === C64_MEMORY_LAYOUT.cartridgeIo2.firstPage) {
      return this.resolveCartridgeRead(this.cartridgePort.readIo2(address), address, 'IO2');
    }
    throw new RangeError(`PLA selected I/O for non-I/O address ${hex(address, 4)}.`);
  }

  private writeIo(address: number, value: number): void {
    const page = address >>> 8;
    if (page >= C64_MEMORY_LAYOUT.vic.firstPage && page <= C64_MEMORY_LAYOUT.vic.lastPage) {
      this.vic.write(address, value);
      return;
    }
    if (page >= C64_MEMORY_LAYOUT.sid.firstPage && page <= C64_MEMORY_LAYOUT.sid.lastPage) {
      this.sid.write(address, value);
      return;
    }
    if (
      page >= C64_MEMORY_LAYOUT.colorRam.firstPage &&
      page <= C64_MEMORY_LAYOUT.colorRam.lastPage
    ) {
      this.colorRam[address - C64_MEMORY_LAYOUT.colorRam.start] = value & 0x0f;
      return;
    }
    if (page === C64_MEMORY_LAYOUT.cia1.firstPage) {
      this.cia1.write(address, value);
      return;
    }
    if (page === C64_MEMORY_LAYOUT.cia2.firstPage) {
      this.cia2.write(address, value);
      return;
    }
    if (page === C64_MEMORY_LAYOUT.cartridgeIo1.firstPage) {
      this.cartridgePort.writeIo1(address, value);
      return;
    }
    if (page === C64_MEMORY_LAYOUT.cartridgeIo2.firstPage) {
      this.cartridgePort.writeIo2(address, value);
      return;
    }
    throw new RangeError(`PLA selected I/O for non-I/O address ${hex(address, 4)}.`);
  }

  private resolveCartridgeRead(
    result: C64CartridgeReadResult,
    address: number,
    signal: 'IO1' | 'IO2' | 'ROMH' | 'ROML',
  ): number {
    if (result === null) return this.vic.phi1DataBusValue;
    if (!Number.isInteger(result) || result < 0 || result > 0xff) {
      throw new RangeError(
        `Cartridge ${signal} read at ${hex(address, 4)} returned invalid byte ${String(result)}.`,
      );
    }
    return result;
  }

  private readFirmwareByte(name: string, image: Uint8Array, offset: number): number {
    const value = image[offset];
    if (value === undefined) {
      throw new RangeError(`${name} ROM offset ${hex(offset, 4)} is outside the loaded image.`);
    }
    return value;
  }

  private assertFirmwareSize(name: string, image: Uint8Array, expected: number): void {
    if (image.length !== expected) {
      throw new RangeError(`${name} ROM must contain ${expected} bytes; received ${image.length}.`);
    }
  }

  private notifyWriteObservers(address: number, value: number): void {
    if (this.writeObservers.size === 0) return;
    const event = { address, value } as const;
    for (const observer of this.writeObservers) observer(event);
  }

  private synchronizeTapeHostSignals(): void {
    const outputPins = this.processorPort.outputPins;
    this.tapePort.setHostSignals({
      motorActive: (outputPins & PROCESSOR_PORT_BIT.cassetteMotor) === 0,
      writeHigh: (outputPins & PROCESSOR_PORT_BIT.cassetteWrite) !== 0,
    });
  }

  private synchronizeSidPaddleInputs(): void {
    const { x, y } = this.controlPorts.paddleInputs;
    this.sid.setPaddleInputs(x, y);
  }

  private synchronizeTapeSense(closed: boolean): void {
    this.processorPort.setInputPins(
      PROCESSOR_PORT_BIT.cassetteSense,
      closed ? 0 : PROCESSOR_PORT_BIT.cassetteSense,
    );
  }

  private pulseTapeReadLine(): void {
    this.tapeReadLineHigh = false;
    this.synchronizeCia1FlagPin();
    this.tapeReadLineHigh = true;
    this.synchronizeCia1FlagPin();
  }

  private synchronizeCia1FlagPin(): void {
    // 磁带 READ 与 IEC /SRQ IN 通过主板接线共同驱动 CIA1 的低有效 FLAG 引脚。
    const flagPinHigh = this.tapeReadLineHigh && this.iecBus.state.serviceRequestHigh;
    this.cia1.setFlagPinHigh(flagPinHigh);
  }

  private synchronizeUserPortBoardSignals(): void {
    this.userPort.setBoardOutputs(this.iecBus.state.attentionHigh, this.iecBus.state.resetHigh);
  }

  private synchronizeUserPortDeviceSignals(
    current: C64UserPortDeviceSignals,
    previous: C64UserPortDeviceSignals,
  ): void {
    this.clockUserPortSerialInput(
      this.cia1,
      previous.cia1SerialClockHigh,
      current.cia1SerialClockHigh,
      current.cia1SerialDataHigh,
    );
    this.clockUserPortSerialInput(
      this.cia2,
      previous.cia2SerialClockHigh,
      current.cia2SerialClockHigh,
      current.cia2SerialDataHigh,
    );
    this.cia2.setFlagPinHigh(current.cia2FlagHigh);
  }

  private clockUserPortSerialInput(
    cia: Cia1 | Cia2,
    previousClockHigh: boolean,
    currentClockHigh: boolean,
    currentDataHigh: boolean,
  ): void {
    cia.setCountPin(currentClockHigh);
    if (previousClockHigh || !currentClockHigh) return;
    cia.pulseCount();
    cia.pulseSerialClock(currentDataHigh);
  }
}

export const C64_MEMORY_SIZE = C64_MEMORY_LAYOUT.addressSpace.size;
