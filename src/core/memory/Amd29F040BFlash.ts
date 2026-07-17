// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - AMD AM29F040B Flash 芯片
//
//   文件:       Amd29F040BFlash.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte } from '../../shared/numbers';

export const AMD_29F040B_FLASH_LAYOUT = {
  addressMask: 0x7ffff,
  byteProgramCycles: 7,
  capacityBytes: 0x80000,
  chipEraseCycles: 8_000_000,
  deviceId: 0xa4,
  deviceIdAddress: 0x01,
  manufacturerId: 0x01,
  sectorCount: 8,
  sectorEraseCycles: 1_000_000,
  sectorEraseWindowCycles: 50,
  sectorSizeBytes: 0x10000,
  statusToggleBit: 1 << 6,
  unlockAddress1: 0x0555,
  unlockAddress2: 0x02aa,
  unlockAddressMask: 0x07ff,
} as const;

export const AMD_29F040B_FLASH_STATE = {
  autoselect: 'autoselect',
  byteProgram: 'byteProgram',
  byteProgramBusy: 'byteProgramBusy',
  byteProgramError: 'byteProgramError',
  chipEraseBusy: 'chipEraseBusy',
  eraseSelect: 'eraseSelect',
  eraseUnlock1: 'eraseUnlock1',
  eraseUnlock2: 'eraseUnlock2',
  read: 'read',
  sectorEraseBusy: 'sectorEraseBusy',
  sectorEraseSuspend: 'sectorEraseSuspend',
  sectorEraseWindow: 'sectorEraseWindow',
  unlock1: 'unlock1',
  unlock2: 'unlock2',
} as const;

export type Amd29F040BFlashState =
  (typeof AMD_29F040B_FLASH_STATE)[keyof typeof AMD_29F040B_FLASH_STATE];

type Amd29F040BBaseState =
  typeof AMD_29F040B_FLASH_STATE.autoselect | typeof AMD_29F040B_FLASH_STATE.read;

interface PendingByteProgram {
  readonly address: number;
  readonly value: number;
}

const FLASH_COMMAND = {
  autoselect: 0x90,
  byteProgram: 0xa0,
  chipErase: 0x10,
  eraseSetup: 0x80,
  eraseSuspend: 0xb0,
  readReset: 0xf0,
  sectorErase: 0x30,
  unlock1: 0xaa,
  unlock2: 0x55,
} as const;

const FLASH_STATUS_BIT = {
  eraseTimerExpired: 1 << 3,
  timeout: 1 << 5,
} as const;

/**
 * AM29F040B 的 C64 可观察命令状态机。
 *
 * 芯片数据在编程/擦除结束前保持不变，忙期间由 DQ7/DQ6/DQ3 报告状态。计时单位是
 * C64 主时钟周期：7 周期字节编程、50 周期扇区选择窗、每扇区 1,000,000 周期和整片
 * 8,000,000 周期。复位只终止命令状态，不会清除非易失内容。
 */
export class Amd29F040BFlash {
  private readonly data: Uint8Array;
  private baseState: Amd29F040BBaseState = AMD_29F040B_FLASH_STATE.read;
  private dirtyValue = false;
  private eraseSectorMask = 0;
  private pendingProgram: PendingByteProgram | undefined;
  private remainingCycles = 0;
  private stateValue: Amd29F040BFlashState = AMD_29F040B_FLASH_STATE.read;
  private statusToggleValue = 0;

  constructor(initialData: Uint8Array) {
    if (initialData.length !== AMD_29F040B_FLASH_LAYOUT.capacityBytes) {
      throw new RangeError(
        `AM29F040B image must contain ${AMD_29F040B_FLASH_LAYOUT.capacityBytes} bytes; ` +
          `received ${initialData.length}.`,
      );
    }
    this.data = initialData.slice();
  }

  get dirty(): boolean {
    return this.dirtyValue;
  }

  get isBusy(): boolean {
    return (
      this.stateValue === AMD_29F040B_FLASH_STATE.byteProgramBusy ||
      this.stateValue === AMD_29F040B_FLASH_STATE.chipEraseBusy ||
      this.stateValue === AMD_29F040B_FLASH_STATE.sectorEraseBusy ||
      this.stateValue === AMD_29F040B_FLASH_STATE.sectorEraseWindow
    );
  }

  get state(): Amd29F040BFlashState {
    return this.stateValue;
  }

  read(address: number): number {
    const normalizedAddress = requireFlashAddress(address);
    switch (this.stateValue) {
      case AMD_29F040B_FLASH_STATE.autoselect:
        return this.readAutoselect(normalizedAddress);
      case AMD_29F040B_FLASH_STATE.byteProgramBusy:
        return this.readProgramStatus(false);
      case AMD_29F040B_FLASH_STATE.byteProgramError:
        return this.readProgramStatus(true);
      case AMD_29F040B_FLASH_STATE.chipEraseBusy:
      case AMD_29F040B_FLASH_STATE.sectorEraseBusy:
      case AMD_29F040B_FLASH_STATE.sectorEraseSuspend:
      case AMD_29F040B_FLASH_STATE.sectorEraseWindow:
        return this.readEraseStatus();
      default:
        return this.requireDataByte(normalizedAddress);
    }
  }

  peek(address: number): number {
    return this.requireDataByte(requireFlashAddress(address));
  }

  reset(): void {
    this.baseState = AMD_29F040B_FLASH_STATE.read;
    this.eraseSectorMask = 0;
    this.pendingProgram = undefined;
    this.remainingCycles = 0;
    this.stateValue = AMD_29F040B_FLASH_STATE.read;
    this.statusToggleValue = 0;
  }

  tick(cycles: number): void {
    requireCycleCount(cycles);
    let cyclesLeft = cycles;
    while (cyclesLeft > 0 && this.isTimedState()) {
      const elapsed = Math.min(cyclesLeft, this.remainingCycles);
      cyclesLeft -= elapsed;
      this.remainingCycles -= elapsed;
      if (this.remainingCycles === 0) this.completeTimedState();
    }
  }

  toBytes(): Uint8Array {
    return this.data.slice();
  }

  write(address: number, value: number): void {
    const normalizedAddress = requireFlashAddress(address);
    const normalizedValue = byte(value);

    switch (this.stateValue) {
      case AMD_29F040B_FLASH_STATE.read:
        if (isUnlockAddress1(normalizedAddress) && normalizedValue === FLASH_COMMAND.unlock1) {
          this.stateValue = AMD_29F040B_FLASH_STATE.unlock1;
        }
        return;
      case AMD_29F040B_FLASH_STATE.unlock1:
        this.stateValue =
          isUnlockAddress2(normalizedAddress) && normalizedValue === FLASH_COMMAND.unlock2
            ? AMD_29F040B_FLASH_STATE.unlock2
            : this.baseState;
        return;
      case AMD_29F040B_FLASH_STATE.unlock2:
        this.handleUnlockedCommand(normalizedAddress, normalizedValue);
        return;
      case AMD_29F040B_FLASH_STATE.autoselect:
      case AMD_29F040B_FLASH_STATE.byteProgramError:
        if (normalizedValue === FLASH_COMMAND.readReset) {
          this.enterReadState();
        } else if (
          isUnlockAddress1(normalizedAddress) &&
          normalizedValue === FLASH_COMMAND.unlock1
        ) {
          this.stateValue = AMD_29F040B_FLASH_STATE.unlock1;
        }
        return;
      case AMD_29F040B_FLASH_STATE.byteProgram:
        this.beginByteProgram(normalizedAddress, normalizedValue);
        return;
      case AMD_29F040B_FLASH_STATE.eraseUnlock1:
        this.stateValue =
          isUnlockAddress1(normalizedAddress) && normalizedValue === FLASH_COMMAND.unlock1
            ? AMD_29F040B_FLASH_STATE.eraseUnlock2
            : this.baseState;
        return;
      case AMD_29F040B_FLASH_STATE.eraseUnlock2:
        this.stateValue =
          isUnlockAddress2(normalizedAddress) && normalizedValue === FLASH_COMMAND.unlock2
            ? AMD_29F040B_FLASH_STATE.eraseSelect
            : this.baseState;
        return;
      case AMD_29F040B_FLASH_STATE.eraseSelect:
        this.handleEraseSelection(normalizedAddress, normalizedValue);
        return;
      case AMD_29F040B_FLASH_STATE.sectorEraseWindow:
        if (normalizedValue === FLASH_COMMAND.sectorErase) {
          this.selectEraseSector(normalizedAddress);
        } else {
          this.cancelSectorErase();
        }
        return;
      case AMD_29F040B_FLASH_STATE.sectorEraseBusy:
        if (normalizedValue === FLASH_COMMAND.eraseSuspend) {
          this.stateValue = AMD_29F040B_FLASH_STATE.sectorEraseSuspend;
        }
        return;
      case AMD_29F040B_FLASH_STATE.sectorEraseSuspend:
        if (normalizedValue === FLASH_COMMAND.sectorErase) {
          this.stateValue = AMD_29F040B_FLASH_STATE.sectorEraseBusy;
        }
        return;
      case AMD_29F040B_FLASH_STATE.byteProgramBusy:
      case AMD_29F040B_FLASH_STATE.chipEraseBusy:
        return;
    }
  }

  private beginByteProgram(address: number, value: number): void {
    const current = this.requireDataByte(address);
    this.statusToggleValue = 0;
    if ((current & value) !== value) {
      this.pendingProgram = { address, value };
      this.stateValue = AMD_29F040B_FLASH_STATE.byteProgramError;
      return;
    }
    this.pendingProgram = { address, value };
    this.remainingCycles = AMD_29F040B_FLASH_LAYOUT.byteProgramCycles;
    this.stateValue = AMD_29F040B_FLASH_STATE.byteProgramBusy;
  }

  private cancelSectorErase(): void {
    this.eraseSectorMask = 0;
    this.remainingCycles = 0;
    this.stateValue = this.baseState;
  }

  private completeTimedState(): void {
    switch (this.stateValue) {
      case AMD_29F040B_FLASH_STATE.byteProgramBusy:
        this.completeByteProgram();
        return;
      case AMD_29F040B_FLASH_STATE.sectorEraseWindow:
        this.remainingCycles = AMD_29F040B_FLASH_LAYOUT.sectorEraseCycles;
        this.stateValue = AMD_29F040B_FLASH_STATE.sectorEraseBusy;
        return;
      case AMD_29F040B_FLASH_STATE.sectorEraseBusy:
        this.completeOneSectorErase();
        return;
      case AMD_29F040B_FLASH_STATE.chipEraseBusy:
        this.data.fill(0xff);
        this.dirtyValue = true;
        this.stateValue = this.baseState;
        return;
      default:
        throw new Error(`AM29F040B timed-state invariant failed in ${this.stateValue}.`);
    }
  }

  private completeByteProgram(): void {
    const pending = this.pendingProgram;
    if (!pending) throw new Error('AM29F040B byte-program state has no pending byte.');
    if (this.data[pending.address] !== pending.value) {
      this.data[pending.address] = pending.value;
      this.dirtyValue = true;
    }
    this.pendingProgram = undefined;
    this.stateValue = this.baseState;
  }

  private completeOneSectorErase(): void {
    const sector = firstSelectedSector(this.eraseSectorMask);
    if (sector === -1) throw new Error('AM29F040B sector-erase state has no selected sector.');
    const start = sector * AMD_29F040B_FLASH_LAYOUT.sectorSizeBytes;
    this.data.fill(0xff, start, start + AMD_29F040B_FLASH_LAYOUT.sectorSizeBytes);
    this.dirtyValue = true;
    this.eraseSectorMask &= ~(1 << sector);
    if (this.eraseSectorMask === 0) {
      this.stateValue = this.baseState;
      return;
    }
    this.remainingCycles = AMD_29F040B_FLASH_LAYOUT.sectorEraseCycles;
  }

  private enterReadState(): void {
    this.baseState = AMD_29F040B_FLASH_STATE.read;
    this.pendingProgram = undefined;
    this.remainingCycles = 0;
    this.stateValue = AMD_29F040B_FLASH_STATE.read;
  }

  private handleEraseSelection(address: number, value: number): void {
    this.statusToggleValue = 0;
    if (isUnlockAddress1(address) && value === FLASH_COMMAND.chipErase) {
      this.remainingCycles = AMD_29F040B_FLASH_LAYOUT.chipEraseCycles;
      this.stateValue = AMD_29F040B_FLASH_STATE.chipEraseBusy;
      return;
    }
    if (value === FLASH_COMMAND.sectorErase) {
      this.eraseSectorMask = 0;
      this.selectEraseSector(address);
      this.remainingCycles = AMD_29F040B_FLASH_LAYOUT.sectorEraseWindowCycles;
      this.stateValue = AMD_29F040B_FLASH_STATE.sectorEraseWindow;
      return;
    }
    this.stateValue = this.baseState;
  }

  private handleUnlockedCommand(address: number, value: number): void {
    if (!isUnlockAddress1(address)) {
      this.stateValue = this.baseState;
      return;
    }
    switch (value) {
      case FLASH_COMMAND.autoselect:
        this.baseState = AMD_29F040B_FLASH_STATE.autoselect;
        this.stateValue = AMD_29F040B_FLASH_STATE.autoselect;
        return;
      case FLASH_COMMAND.byteProgram:
        this.stateValue = AMD_29F040B_FLASH_STATE.byteProgram;
        return;
      case FLASH_COMMAND.eraseSetup:
        this.stateValue = AMD_29F040B_FLASH_STATE.eraseUnlock1;
        return;
      case FLASH_COMMAND.readReset:
        this.enterReadState();
        return;
      default:
        this.stateValue = this.baseState;
    }
  }

  private isTimedState(): boolean {
    return (
      this.stateValue === AMD_29F040B_FLASH_STATE.byteProgramBusy ||
      this.stateValue === AMD_29F040B_FLASH_STATE.chipEraseBusy ||
      this.stateValue === AMD_29F040B_FLASH_STATE.sectorEraseBusy ||
      this.stateValue === AMD_29F040B_FLASH_STATE.sectorEraseWindow
    );
  }

  private readAutoselect(address: number): number {
    switch (address & 0xff) {
      case 0:
        return AMD_29F040B_FLASH_LAYOUT.manufacturerId;
      case AMD_29F040B_FLASH_LAYOUT.deviceIdAddress:
        return AMD_29F040B_FLASH_LAYOUT.deviceId;
      case 2:
        return 0;
      default:
        return this.requireDataByte(address);
    }
  }

  private readEraseStatus(): number {
    const timerBit =
      this.stateValue === AMD_29F040B_FLASH_STATE.sectorEraseWindow
        ? 0
        : FLASH_STATUS_BIT.eraseTimerExpired;
    const value = this.statusToggleValue | timerBit;
    this.statusToggleValue ^= AMD_29F040B_FLASH_LAYOUT.statusToggleBit;
    return value;
  }

  private readProgramStatus(error: boolean): number {
    const programmedValue = this.pendingProgram?.value;
    if (programmedValue === undefined) {
      throw new Error('AM29F040B program-status state has no pending byte.');
    }
    const value =
      ((programmedValue ^ 0x80) & 0x80) |
      this.statusToggleValue |
      (error ? FLASH_STATUS_BIT.timeout : 0);
    this.statusToggleValue ^= AMD_29F040B_FLASH_LAYOUT.statusToggleBit;
    return value;
  }

  private requireDataByte(address: number): number {
    const value = this.data[address];
    if (value === undefined) {
      throw new RangeError(`AM29F040B address $${address.toString(16)} is outside flash data.`);
    }
    return value;
  }

  private selectEraseSector(address: number): void {
    const sector = Math.trunc(address / AMD_29F040B_FLASH_LAYOUT.sectorSizeBytes);
    this.eraseSectorMask |= 1 << sector;
  }
}

function firstSelectedSector(mask: number): number {
  for (let sector = 0; sector < AMD_29F040B_FLASH_LAYOUT.sectorCount; sector += 1) {
    if ((mask & (1 << sector)) !== 0) return sector;
  }
  return -1;
}

function isUnlockAddress1(address: number): boolean {
  return (
    (address & AMD_29F040B_FLASH_LAYOUT.unlockAddressMask) ===
    AMD_29F040B_FLASH_LAYOUT.unlockAddress1
  );
}

function isUnlockAddress2(address: number): boolean {
  return (
    (address & AMD_29F040B_FLASH_LAYOUT.unlockAddressMask) ===
    AMD_29F040B_FLASH_LAYOUT.unlockAddress2
  );
}

function requireCycleCount(cycles: number): void {
  if (Number.isSafeInteger(cycles) && cycles >= 0) return;
  throw new RangeError(`AM29F040B cycle count must be a non-negative integer; received ${cycles}.`);
}

function requireFlashAddress(address: number): number {
  if (
    Number.isSafeInteger(address) &&
    address >= 0 &&
    address < AMD_29F040B_FLASH_LAYOUT.capacityBytes
  ) {
    return address;
  }
  throw new RangeError(
    `AM29F040B address must be from $00000 through $${AMD_29F040B_FLASH_LAYOUT.addressMask.toString(16)}; ` +
      `received ${address}.`,
  );
}
