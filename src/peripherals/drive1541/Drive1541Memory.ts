// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 内存地址译码
//
//   文件:       Drive1541Memory.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { MemoryBus } from '../../core/memory/MemoryBus';
import { byte, word } from '../../shared/numbers';
import type { Drive1541DiskVia } from './Drive1541DiskVia';
import type { Drive1541IecVia } from './Drive1541IecVia';

export const DRIVE_1541_MEMORY_LAYOUT = {
  addressSpaceSize: 0x1_0000,
  decodedRegionMask: 0x1fff,
  diskVia: { end: 0x1fff, start: 0x1c00 },
  iecVia: { end: 0x1bff, start: 0x1800 },
  ram: { decodeEnd: 0x07ff, size: 0x0800 },
  rom: { imageSize: 0x4000, mirrorStart: 0x8000, primaryStart: 0xc000 },
  stackPageStart: 0x0100,
} as const;

export type Drive1541BusAccessKind = 'read' | 'write';

export interface Drive1541BusCycleObserver {
  completeCpuBusCycle(): void;
  startCpuBusCycle(kind: Drive1541BusAccessKind, address: number): void;
}

export interface Drive1541MemoryDevices {
  readonly diskVia: Drive1541DiskVia;
  readonly iecVia: Drive1541IecVia;
}

/** 1541 长板的地址译码器，包括未选中器件时保持上一次数据的开放总线。 */
export class Drive1541Memory implements MemoryBus {
  readonly ram = new Uint8Array(DRIVE_1541_MEMORY_LAYOUT.ram.size);
  readonly diskVia: Drive1541DiskVia;
  readonly iecVia: Drive1541IecVia;

  private dataBusValue = 0xff;
  private cpuBusCycleObserver: Drive1541BusCycleObserver | undefined;

  constructor(
    private readonly rom: Uint8Array,
    devices: Drive1541MemoryDevices,
  ) {
    if (rom.length !== DRIVE_1541_MEMORY_LAYOUT.rom.imageSize) {
      throw new RangeError(
        `Commodore 1541 ROM must contain ${DRIVE_1541_MEMORY_LAYOUT.rom.imageSize} bytes; received ${rom.length}.`,
      );
    }
    this.diskVia = devices.diskVia;
    this.iecVia = devices.iecVia;
  }

  get lastDataBusValue(): number {
    return this.dataBusValue;
  }

  read(address: number): number {
    const normalized = word(address);
    const observer = this.cpuBusCycleObserver;
    observer?.startCpuBusCycle('read', normalized);
    try {
      this.dataBusValue = this.readDecoded(normalized);
      return this.dataBusValue;
    } finally {
      observer?.completeCpuBusCycle();
    }
  }

  readWord(address: number): number {
    const normalized = word(address);
    return this.read(normalized) | (this.read(word(normalized + 1)) << 8);
  }

  readStack(stackPointer: number): number {
    return this.read(DRIVE_1541_MEMORY_LAYOUT.stackPageStart + byte(stackPointer));
  }

  write(address: number, value: number): void {
    const normalized = word(address);
    const normalizedValue = byte(value);
    const observer = this.cpuBusCycleObserver;
    observer?.startCpuBusCycle('write', normalized);
    try {
      // 即使没有存储器响应，CPU 仍会在写周期主动驱动数据总线。
      this.dataBusValue = normalizedValue;
      this.writeDecoded(normalized, normalizedValue);
    } finally {
      observer?.completeCpuBusCycle();
    }
  }

  writeWord(address: number, value: number): void {
    const normalized = word(address);
    this.write(normalized, value);
    this.write(word(normalized + 1), value >>> 8);
  }

  writeStack(stackPointer: number, value: number): void {
    this.write(DRIVE_1541_MEMORY_LAYOUT.stackPageStart + byte(stackPointer), value);
  }

  setCpuBusCycleObserver(
    observer: Drive1541BusCycleObserver | undefined,
  ): Drive1541BusCycleObserver | undefined {
    const previous = this.cpuBusCycleObserver;
    this.cpuBusCycleObserver = observer;
    return previous;
  }

  resetHardware(): void {
    this.dataBusValue = 0xff;
    this.iecVia.reset();
    this.diskVia.reset();
  }

  private readDecoded(address: number): number {
    if (address >= DRIVE_1541_MEMORY_LAYOUT.rom.mirrorStart) {
      const offset =
        (address - DRIVE_1541_MEMORY_LAYOUT.rom.mirrorStart) &
        (DRIVE_1541_MEMORY_LAYOUT.rom.imageSize - 1);
      const value = this.rom[offset];
      if (value === undefined)
        throw new RangeError(`1541 ROM offset ${offset} is outside its image.`);
      return value;
    }

    const decodedAddress = address & DRIVE_1541_MEMORY_LAYOUT.decodedRegionMask;
    if (decodedAddress <= DRIVE_1541_MEMORY_LAYOUT.ram.decodeEnd) {
      const value = this.ram[decodedAddress];
      if (value === undefined)
        throw new RangeError(`1541 RAM offset ${decodedAddress} is invalid.`);
      return value;
    }
    if (
      decodedAddress >= DRIVE_1541_MEMORY_LAYOUT.iecVia.start &&
      decodedAddress <= DRIVE_1541_MEMORY_LAYOUT.iecVia.end
    ) {
      return this.iecVia.read(decodedAddress);
    }
    if (
      decodedAddress >= DRIVE_1541_MEMORY_LAYOUT.diskVia.start &&
      decodedAddress <= DRIVE_1541_MEMORY_LAYOUT.diskVia.end
    ) {
      return this.diskVia.read(decodedAddress);
    }
    return this.dataBusValue;
  }

  private writeDecoded(address: number, value: number): void {
    if (address >= DRIVE_1541_MEMORY_LAYOUT.rom.mirrorStart) return;

    const decodedAddress = address & DRIVE_1541_MEMORY_LAYOUT.decodedRegionMask;
    if (decodedAddress <= DRIVE_1541_MEMORY_LAYOUT.ram.decodeEnd) {
      this.ram[decodedAddress] = value;
      return;
    }
    if (
      decodedAddress >= DRIVE_1541_MEMORY_LAYOUT.iecVia.start &&
      decodedAddress <= DRIVE_1541_MEMORY_LAYOUT.iecVia.end
    ) {
      this.iecVia.write(decodedAddress, value);
      return;
    }
    if (
      decodedAddress >= DRIVE_1541_MEMORY_LAYOUT.diskVia.start &&
      decodedAddress <= DRIVE_1541_MEMORY_LAYOUT.diskVia.end
    ) {
      this.diskVia.write(decodedAddress, value);
    }
  }
}
