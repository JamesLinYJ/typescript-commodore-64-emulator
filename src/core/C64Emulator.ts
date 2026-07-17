// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 模拟器公共控制接口
//
//   文件:       C64Emulator.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { C64CartridgePort } from './memory/C64CartridgePort';
import { createCartridgeFromCrt } from '../media/CrtImageParser';
import { D64DiskImage, type D64DiskImageOptions } from '../media/D64DiskImage';
import { G64DiskImage, type G64DiskImageOptions } from '../media/G64DiskImage';
import {
  installPrg,
  parsePrg,
  PRG_START_MODE,
  type InstallPrgOptions,
  type LoadedProgram,
} from '../media/PrgLoader';
import { parseTapImage, type TapImage, type TapImageParserOptions } from '../media/TapImageParser';
import { WritableTapImage, type WritableTapImageOptions } from '../media/WritableTapImage';
import {
  Commodore1541Drive,
  type Commodore1541DriveOptions,
} from '../peripherals/drive1541/Commodore1541Drive';
import type { DatasetteTapeImage } from '../peripherals/tape/Commodore1530Datasette';
import type { IecBus } from '../peripherals/iec/IecBus';
import type { SidModel } from '../devices/SidModel';
import type { C64ControlPortNumber } from '../peripherals/control/C64ControlPorts';
import {
  DEFAULT_FIRMWARE_URLS,
  fetchBinary,
  loadFirmware,
  type BinaryFetcher,
  type FirmwareUrls,
} from '../platform/FirmwareLoader';
import { TypedEventEmitter } from '../shared/TypedEventEmitter';
import { CanvasRenderer, type RendererState } from '../video/CanvasRenderer';
import { Cpu6502 } from './cpu/Cpu6502';
import type { CpuRegisters } from './cpu/CpuRegisters';
import { C64Memory, type C64CiaModels } from './memory/C64Memory';
import { WebAudioOutput } from '../platform/WebAudioOutput';
import { BrowserC64Input } from '../platform/BrowserC64Input';
import { hasBasicReadyPrompt } from './basicStartup';

export interface C64EmulatorOptions {
  readonly cartridge?: C64CartridgePort;
  readonly canvas?: HTMLCanvasElement;
  readonly canvasHost?: HTMLElement;
  readonly ciaModels?: C64CiaModels;
  readonly debug?: boolean;
  readonly drive1541?: Omit<Commodore1541DriveOptions, 'debug' | 'iecBus'>;
  readonly sidModel?: SidModel;
  readonly fetcher?: BinaryFetcher;
  readonly firmwareUrls?: FirmwareUrls;
  readonly iecBus?: IecBus;
  readonly joystickPort?: C64ControlPortNumber | null;
  readonly keyboardTarget?: EventTarget;
  readonly audioTarget?: EventTarget;
  readonly signal?: AbortSignal;
}

export interface C64ProgramLoadOptions extends InstallPrgOptions {
  readonly resetMachine?: boolean;
}

export interface C64RemoteProgramLoadOptions extends C64ProgramLoadOptions {
  readonly signal?: AbortSignal;
}

interface EmulatorEvents {
  readonly error: Error;
  readonly frame: { readonly frameNumber: number; readonly renderTime: number };
  readonly programLoaded: LoadedProgram;
  readonly state: RendererState;
}

const PRG_AUTOSTART_BOOT_FRAME_LIMIT = 300;

export class C64Emulator extends TypedEventEmitter<EmulatorEvents> {
  readonly cpu: Cpu6502;
  readonly drive1541: Commodore1541Drive | undefined;
  readonly input: BrowserC64Input;
  readonly memory: C64Memory;
  readonly renderer: CanvasRenderer;

  private readonly stopObservingUserPortDeviceSignals: () => void;
  private resumeAfterUserPortReset = false;

  private constructor(
    memory: C64Memory,
    cpu: Cpu6502,
    renderer: CanvasRenderer,
    input: BrowserC64Input,
    private readonly fetcher: BinaryFetcher,
    private readonly audioOutput: WebAudioOutput,
    drive1541: Commodore1541Drive | undefined,
  ) {
    super();
    this.memory = memory;
    this.cpu = cpu;
    this.drive1541 = drive1541;
    this.input = input;
    this.renderer = renderer;
    this.stopObservingUserPortDeviceSignals = memory.userPort.observeDeviceSignals(
      ({ current, previous }) => {
        if (current.resetPulledLow === previous.resetPulledLow) return;
        this.handleUserPortResetLine(current.resetPulledLow);
      },
    );
    renderer.on('frame', (event) => this.emit('frame', event));
    renderer.on('audio', ({ sampleRate, samples }) => audioOutput.enqueue(samples, sampleRate));
    renderer.on('state', (state) => this.emit('state', state));
    renderer.on('error', (error) => this.emit('error', error));
    renderer.on('breakpoint', (error) => this.emit('error', error));
  }

  static async create(options: C64EmulatorOptions = {}): Promise<C64Emulator> {
    const fetcher = options.fetcher ?? fetch;
    const firmware = await loadFirmware(
      options.firmwareUrls ?? DEFAULT_FIRMWARE_URLS,
      fetcher,
      options.signal,
    );
    const memory = new C64Memory(firmware, {
      ...(options.cartridge ? { cartridge: options.cartridge } : {}),
      ...(options.ciaModels ? { ciaModels: options.ciaModels } : {}),
      debug: options.debug ?? false,
      ...(options.iecBus ? { iecBus: options.iecBus } : {}),
      ...(options.sidModel ? { sidModel: options.sidModel } : {}),
    });
    const cpu = new Cpu6502(memory);
    const drive1541 = options.drive1541
      ? new Commodore1541Drive({
          debug: options.debug ?? false,
          deviceNumber: options.drive1541.deviceNumber ?? 8,
          iecBus: memory.iecBus,
          rom: options.drive1541.rom,
        })
      : undefined;
    const canvas = options.canvas ?? document.createElement('canvas');
    if (!options.canvas && options.canvasHost) options.canvasHost.append(canvas);
    const renderer = new CanvasRenderer(
      cpu,
      memory,
      canvas,
      undefined,
      drive1541 ? [drive1541.clock] : [],
    );
    const audioOutput = new WebAudioOutput(options.audioTarget ?? document);
    const input = new BrowserC64Input({
      controlPorts: memory.controlPorts,
      ...(options.joystickPort !== undefined ? { joystickPort: options.joystickPort } : {}),
      keyboard: memory.cia1.keyboard,
      restoreKeyInput: memory.restoreKey,
    });
    input.attach(options.keyboardTarget ?? document);
    return new C64Emulator(memory, cpu, renderer, input, fetcher, audioOutput, drive1541);
  }

  get state(): RendererState {
    return this.renderer.currentState;
  }

  get registers(): CpuRegisters {
    return this.cpu.getRegisters();
  }

  get basicReady(): boolean {
    return hasBasicReadyPrompt(this.memory);
  }

  start(): void {
    if (this.memory.userPort.deviceSignals.resetPulledLow) return;
    this.renderer.start();
  }

  pause(): void {
    if (this.memory.userPort.deviceSignals.resetPulledLow) {
      this.resumeAfterUserPortReset = false;
    }
    this.renderer.pause();
  }

  toggle(): void {
    if (this.memory.userPort.deviceSignals.resetPulledLow) return;
    this.renderer.toggle();
  }

  reset(): void {
    this.audioOutput.clear();
    this.renderer.resetTiming();
    this.memory.resetHardware();
    this.cpu.reset();
  }

  stepInstruction(): number {
    this.requireReleasedUserPortReset();
    return this.renderer.stepInstruction();
  }

  stepFrame(): void {
    this.requireReleasedUserPortReset();
    this.renderer.stepFrame();
  }

  insertCartridge(cartridge: C64CartridgePort, resetMachine = true): void {
    this.memory.insertCartridge(cartridge);
    if (resetMachine) this.reset();
  }

  ejectCartridge(resetMachine = true): void {
    this.memory.ejectCartridge();
    if (resetMachine) this.reset();
  }

  async loadCartridge(
    url: string,
    options: { readonly resetMachine?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<C64CartridgePort> {
    const bytes = await fetchBinary(url, this.fetcher, options.signal);
    return this.loadCartridgeBytes(bytes, options.resetMachine ?? true);
  }

  loadCartridgeBytes(input: ArrayBuffer | Uint8Array, resetMachine = true): C64CartridgePort {
    const cartridge = createCartridgeFromCrt(input);
    this.insertCartridge(cartridge, resetMachine);
    return cartridge;
  }

  async loadProgram(
    url: string,
    options: C64RemoteProgramLoadOptions = {},
  ): Promise<LoadedProgram> {
    const bytes = await fetchBinary(url, this.fetcher, options.signal);
    return this.loadProgramBytes(bytes, options);
  }

  loadProgramBytes(
    input: ArrayBuffer | Uint8Array,
    options: C64ProgramLoadOptions = {},
  ): LoadedProgram {
    const startMode = options.startMode ?? PRG_START_MODE.basicRun;
    const resetMachine = options.resetMachine ?? startMode !== PRG_START_MODE.none;
    const resumeAfterLoad = this.renderer.isRunning;

    if (resetMachine) {
      this.renderer.pause();
      this.reset();
      this.bootToBasicReady();
    } else if (startMode === PRG_START_MODE.basicRun && !this.basicReady) {
      throw new Error('C64 BASIC must be ready before a PRG can be started with RUN.');
    }

    try {
      const installOptions: InstallPrgOptions =
        options.entryAddress === undefined
          ? { startMode }
          : { entryAddress: options.entryAddress, startMode };
      const loaded = installPrg(parsePrg(input), this.memory, this.cpu, installOptions);
      this.emit('programLoaded', loaded);
      if (resumeAfterLoad) this.renderer.start();
      return loaded;
    } catch (error: unknown) {
      // 装载失败后保留暂停状态，避免从已复位但未完整安装的机器继续随机执行。
      this.renderer.pause();
      throw error;
    }
  }

  mountD64(input: ArrayBuffer | Uint8Array, options: D64DiskImageOptions = {}): D64DiskImage {
    const drive = this.drive1541;
    if (!drive) {
      throw new Error('No Commodore 1541 was configured when this emulator instance was created.');
    }
    return drive.mountD64(input, options);
  }

  ejectD64(): D64DiskImage {
    const drive = this.drive1541;
    if (!drive) {
      throw new Error('No Commodore 1541 was configured when this emulator instance was created.');
    }
    return drive.ejectD64();
  }

  mountG64(input: ArrayBuffer | Uint8Array, options: G64DiskImageOptions = {}): G64DiskImage {
    const drive = this.drive1541;
    if (!drive) {
      throw new Error('No Commodore 1541 was configured when this emulator instance was created.');
    }
    return drive.mountG64(input, options);
  }

  ejectG64(): G64DiskImage {
    const drive = this.drive1541;
    if (!drive) {
      throw new Error('No Commodore 1541 was configured when this emulator instance was created.');
    }
    return drive.ejectG64();
  }

  mountTap(input: ArrayBuffer | Uint8Array, options: TapImageParserOptions = {}): TapImage {
    const image = parseTapImage(input, options);
    this.memory.datasette.insertTape(image);
    return image;
  }

  mountBlankTap(options: WritableTapImageOptions = {}): WritableTapImage {
    const image = new WritableTapImage(options);
    this.memory.datasette.insertTape(image);
    return image;
  }

  ejectTap(): DatasetteTapeImage {
    return this.memory.datasette.ejectTape();
  }

  playTape(): void {
    this.memory.datasette.pressPlay();
  }

  recordTape(): void {
    this.memory.datasette.pressRecord();
  }

  stopTape(): void {
    this.memory.datasette.pressStop();
  }

  rewindTape(): void {
    this.memory.datasette.rewindToStart();
  }

  dispose(): void {
    this.renderer.dispose();
    this.audioOutput.dispose();
    this.input.dispose();
    this.memory.datasette.disconnect();
    this.drive1541?.dispose();
    this.stopObservingUserPortDeviceSignals();
    this.clearListeners();
  }

  private handleUserPortResetLine(asserted: boolean): void {
    if (asserted) {
      this.resumeAfterUserPortReset = this.renderer.isRunning;
      this.renderer.pause();
      this.reset();
      return;
    }
    if (!this.resumeAfterUserPortReset) return;
    this.resumeAfterUserPortReset = false;
    this.renderer.start();
  }

  private requireReleasedUserPortReset(): void {
    if (this.memory.userPort.deviceSignals.resetPulledLow) {
      throw new Error('Cannot execute the C64 while the User Port RESET line is held low.');
    }
  }

  private bootToBasicReady(): void {
    let readyWasAbsent = !this.basicReady;
    for (let frame = 0; frame < PRG_AUTOSTART_BOOT_FRAME_LIMIT; frame += 1) {
      this.renderer.stepFrame();
      const ready = this.basicReady;
      if (!ready) readyWasAbsent = true;
      else if (readyWasAbsent) return;
    }
    throw new Error(
      `C64 BASIC did not reach READY within ${PRG_AUTOSTART_BOOT_FRAME_LIMIT} PAL frames.`,
    );
  }
}
