// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - MOS 6526 CIA 核心
//
//   文件:       Mos6526.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { byte, fromBcd, toBcd } from '../shared/numbers';
import {
  CIA_INTERRUPT_BIT,
  CIA_PORT_BIT,
  CIA_REGISTER,
  CIA_REGISTER_COUNT,
  CIA_TIME_OF_DAY,
  CIA_TIMER_B_INPUT_MODE,
  CIA_TIMER_CONTROL_BIT,
  MOS_6526_DEFAULT_TIMING,
} from './ciaRegisters';
import { IoDevice } from './IoDevice';
import { Mos6526Timer } from './Mos6526Timer';
import { DEFAULT_MOS_6526_MODEL, MOS_6526_MODEL, type Mos6526Model } from './Mos6526Model';
import { Mos6526SerialPort } from './Mos6526SerialPort';

export interface Mos6526Timing {
  readonly processorClockHz: number;
  readonly timeOfDayInputHz: number;
}

export interface Mos6526Options {
  readonly debug?: boolean;
  readonly model?: Mos6526Model;
  readonly timing?: Mos6526Timing;
}

const TOD_REGISTER_ORDER = [
  CIA_REGISTER.timeOfDayTenths,
  CIA_REGISTER.timeOfDaySeconds,
  CIA_REGISTER.timeOfDayMinutes,
  CIA_REGISTER.timeOfDayHours,
] as const;

const INTERRUPT_PIPELINE = {
  acknowledgeStage1: 0x0001,
  acknowledgeStage0: 0x0002,
  acknowledgeCancellationWindow: 0x0004,
  acknowledgeExpired: 0x0008,
  setDataBitStage1: 0x0010,
  setDataBitStage0: 0x0020,
  setDataBitExpired: 0x0040,
  raiseStage1: 0x0100,
  raiseStage0: 0x0200,
  raiseExpired: 0x0400,
  readStage0: 0x1000,
  readStage1: 0x2000,
  readExpired: 0x4000,
} as const;

const INTERRUPT_PIPELINE_EXPIRED_MASK =
  INTERRUPT_PIPELINE.acknowledgeExpired |
  INTERRUPT_PIPELINE.setDataBitExpired |
  INTERRUPT_PIPELINE.raiseExpired |
  INTERRUPT_PIPELINE.readExpired;

export class Mos6526 extends IoDevice {
  private readonly timerA = new Mos6526Timer();
  private readonly timerB = new Mos6526Timer();
  private readonly timeOfDay = new Uint8Array(CIA_TIME_OF_DAY.registerCount);
  private readonly alarm = new Uint8Array(CIA_TIME_OF_DAY.registerCount);
  private timeOfDayReadLatch: Uint8Array | undefined;
  private interruptFlags = 0;
  private interruptMask = 0;
  private acknowledgedInterruptFlags = 0;
  private newInterruptFlags = 0;
  private interruptPipeline = 0;
  private interruptLineAsserted = false;
  private elapsedCycleCount = 0;
  private lastInterruptControlReadCycle = Number.NEGATIVE_INFINITY;
  private timerBReadCollision = false;
  private readonly serialPort = new Mos6526SerialPort();
  private timeOfDayCycleAccumulator = 0;
  private timeOfDayDividerPhase = 0;
  private timeOfDayStopped = true;
  private countPinHigh = true;
  private flagPinHigh = true;
  private portControlOutputHighValue = true;
  private portControlPulseCyclesRemaining = 0;
  readonly model: Mos6526Model;
  private readonly timing: Mos6526Timing;
  private readonly processorCyclesPerTimeOfDayInputPulse: number;

  constructor(deviceName = 'MOS 6526', options: Mos6526Options = {}) {
    super(deviceName, CIA_REGISTER_COUNT, options.debug ?? false);
    this.model = options.model ?? DEFAULT_MOS_6526_MODEL;
    this.timing = options.timing ?? MOS_6526_DEFAULT_TIMING;
    if (this.timing.processorClockHz <= 0 || this.timing.timeOfDayInputHz <= 0) {
      throw new RangeError('MOS 6526 clock frequencies must be positive.');
    }
    this.processorCyclesPerTimeOfDayInputPulse =
      this.timing.processorClockHz / this.timing.timeOfDayInputHz;
    this.installRegisterMap();
    this.reset();
  }

  get interruptPending(): boolean {
    return this.interruptLineAsserted;
  }

  get portAOutputPins(): number {
    return this.composePortOutput(CIA_REGISTER.portA, CIA_REGISTER.dataDirectionA);
  }

  get portAOutputLatch(): number {
    return this.registers[CIA_REGISTER.portA] ?? 0;
  }

  get portADataDirection(): number {
    return this.registers[CIA_REGISTER.dataDirectionA] ?? 0;
  }

  get portBOutputPins(): number {
    let pins = this.composePortOutput(CIA_REGISTER.portB, CIA_REGISTER.dataDirectionB);
    const timerAControl = this.registers[CIA_REGISTER.timerAControl] ?? 0;
    const timerBControl = this.registers[CIA_REGISTER.timerBControl] ?? 0;
    if ((timerAControl & CIA_TIMER_CONTROL_BIT.portBOutput) !== 0) {
      pins = this.setPinLevel(pins, CIA_PORT_BIT.timerAOutput, this.timerA.outputHigh);
    }
    if ((timerBControl & CIA_TIMER_CONTROL_BIT.portBOutput) !== 0) {
      pins = this.setPinLevel(pins, CIA_PORT_BIT.timerBOutput, this.timerB.outputHigh);
    }
    return pins;
  }

  get portBOutputLatch(): number {
    return this.registers[CIA_REGISTER.portB] ?? 0;
  }

  get portBDataDirection(): number {
    return this.registers[CIA_REGISTER.dataDirectionB] ?? 0;
  }

  /** 输出模式下的 CNT 引脚电平；空闲时保持高电平。 */
  get serialClockOutputHigh(): boolean {
    return this.serialPort.clockOutputHigh;
  }

  /** 输出模式下的 SP 引脚电平；空闲时保持高电平。 */
  get serialDataOutputHigh(): boolean {
    return this.serialPort.dataOutputHigh;
  }

  /** `/PC` 在 Port B 读写后拉低一个芯片周期，供并行外设作握手选通。 */
  get portControlOutputHigh(): boolean {
    return this.portControlOutputHighValue;
  }

  reset(): void {
    this.registers.fill(0);
    this.timerA.reset();
    this.timerB.reset();
    this.timeOfDay.fill(0);
    this.alarm.fill(0);
    this.timeOfDayReadLatch = undefined;
    this.interruptFlags = 0;
    this.interruptMask = 0;
    this.acknowledgedInterruptFlags = 0;
    this.newInterruptFlags = 0;
    this.interruptPipeline = 0;
    this.interruptLineAsserted = false;
    this.elapsedCycleCount = 0;
    this.lastInterruptControlReadCycle = Number.NEGATIVE_INFINITY;
    this.timerBReadCollision = false;
    this.serialPort.reset();
    this.timeOfDayCycleAccumulator = 0;
    this.timeOfDayDividerPhase = 0;
    this.timeOfDayStopped = true;
    this.countPinHigh = true;
    this.portControlOutputHighValue = true;
    this.portControlPulseCyclesRemaining = 0;
    this.onPortAOutputChanged(this.portAOutputPins);
    this.onPortBOutputChanged(this.portBOutputPins);
    this.onPortControlOutputChanged(true);
    this.onSerialOutputChanged(this.serialClockOutputHigh, this.serialDataOutputHigh);
  }

  tick(cycles: number): boolean {
    const elapsedCycles = Math.max(0, Math.trunc(cycles));
    if (elapsedCycles === 0) return this.interruptPending;

    const timerOutputRoutedToPortB = this.timerOutputRoutedToPortB;
    const portBOutputBefore = timerOutputRoutedToPortB ? this.portBOutputPins : 0;
    for (let cycle = 0; cycle < elapsedCycles; cycle += 1) {
      this.runProcessorClockCycle();
    }
    if (timerOutputRoutedToPortB) {
      const portBOutputAfter = this.portBOutputPins;
      if (portBOutputAfter !== portBOutputBefore) {
        this.onPortBOutputChanged(portBOutputAfter);
      }
    }
    this.tickTimeOfDayFromProcessorCycles(elapsedCycles);
    return this.interruptPending;
  }

  /** 推进单个处理器时钟，避免整机热路径重复执行批量参数规范化与循环。 */
  clockCycle(): boolean {
    // 只有 CRA/CRB 把定时器输出路由到 PB6/PB7 时，芯片时钟才可能改变
    // Port B 引脚。普通键盘/IEC 周期直接跳过两次引脚合成与比较。
    const timerOutputRoutedToPortB = this.timerOutputRoutedToPortB;
    const portBOutputBefore = timerOutputRoutedToPortB ? this.portBOutputPins : 0;
    this.runProcessorClockCycle();
    if (timerOutputRoutedToPortB) {
      const portBOutputAfter = this.portBOutputPins;
      if (portBOutputAfter !== portBOutputBefore) {
        this.onPortBOutputChanged(portBOutputAfter);
      }
    }
    this.tickTimeOfDayFromProcessorCycles(1);
    return this.interruptPending;
  }

  pulseCount(count = 1): boolean {
    const pulses = Math.max(0, Math.trunc(count));
    if (pulses === 0) return this.interruptPending;

    const timerOutputRoutedToPortB = this.timerOutputRoutedToPortB;
    const portBOutputBefore = timerOutputRoutedToPortB ? this.portBOutputPins : 0;
    for (let pulse = 0; pulse < pulses; pulse += 1) {
      if (this.serialPort.tickCycle()) this.raiseInterrupt(CIA_INTERRUPT_BIT.serial);
      const timerAUnderflow =
        this.timerA.inputMode === CIA_TIMER_B_INPUT_MODE.countPin && this.timerA.tickCycle(true);
      if (timerAUnderflow) {
        this.synchronizeStoppedTimerStartBit(CIA_REGISTER.timerAControl, this.timerA.running);
        this.raiseInterrupt(CIA_INTERRUPT_BIT.timerA);
        this.clockSerialOutput();
      }
      const timerBStep =
        this.timerB.inputMode === CIA_TIMER_B_INPUT_MODE.countPin ||
        ((this.timerB.inputMode === CIA_TIMER_B_INPUT_MODE.timerAUnderflow ||
          (this.timerB.inputMode === CIA_TIMER_B_INPUT_MODE.timerAUnderflowWhileCountHigh &&
            this.countPinHigh)) &&
          timerAUnderflow);
      if (timerBStep && this.timerB.tickCycle(true)) {
        this.synchronizeStoppedTimerStartBit(CIA_REGISTER.timerBControl, this.timerB.running);
        this.raiseInterrupt(CIA_INTERRUPT_BIT.timerB);
      }
      this.runInterruptPipelineCycle();
    }
    if (timerOutputRoutedToPortB) {
      const portBOutputAfter = this.portBOutputPins;
      if (portBOutputAfter !== portBOutputBefore) {
        this.onPortBOutputChanged(portBOutputAfter);
      }
    }
    return this.interruptPending;
  }

  setCountPin(high: boolean): void {
    this.countPinHigh = high;
  }

  /** FLAG 是低有效边沿输入；保持低电平不会重复产生中断。 */
  setFlagPinHigh(high: boolean): void {
    if (this.flagPinHigh && !high) this.raiseInterrupt(CIA_INTERRUPT_BIT.flag);
    this.flagPinHigh = high;
  }

  pulseFlag(): void {
    this.setFlagPinHigh(false);
    this.setFlagPinHigh(true);
  }

  pulseSerialClock(inputBit: boolean): void {
    const control = this.registers[CIA_REGISTER.timerAControl] ?? 0;
    if ((control & CIA_TIMER_CONTROL_BIT.serialOutputMode) !== 0) return;

    const result = this.serialPort.clockInputBit(inputBit);
    if (result.completed) {
      this.registers[CIA_REGISTER.serialData] = result.value;
      this.raiseInterrupt(CIA_INTERRUPT_BIT.serial);
    }
  }

  tickTimeOfDayInput(pulses = 1): void {
    const inputPulses = Math.max(0, Math.trunc(pulses));
    if (this.timeOfDayStopped) return;
    const control = this.registers[CIA_REGISTER.timerAControl] ?? 0;
    const terminalPhase =
      (control & CIA_TIMER_CONTROL_BIT.timeOfDay50Hz) !== 0
        ? CIA_TIME_OF_DAY.inputPulsesAt50Hz - 1
        : CIA_TIME_OF_DAY.inputPulsesAt60Hz - 1;
    const phaseCount = CIA_TIME_OF_DAY.inputPulsesAt60Hz;

    // 三位环形分频器有六个有效相位。每个输入边沿先比较当前相位；
    // 50 Hz 在相位 4 提前回零，60 Hz 则在相位 5 回零。
    const pulsesUntilFirstUpdate =
      this.timeOfDayDividerPhase <= terminalPhase
        ? terminalPhase - this.timeOfDayDividerPhase + 1
        : phaseCount - this.timeOfDayDividerPhase + terminalPhase + 1;
    if (inputPulses < pulsesUntilFirstUpdate) {
      this.timeOfDayDividerPhase = (this.timeOfDayDividerPhase + inputPulses) % phaseCount;
      return;
    }

    const pulsesAfterFirstUpdate = inputPulses - pulsesUntilFirstUpdate;
    const pulsesPerFollowingUpdate = terminalPhase + 1;
    const updateCount = 1 + Math.floor(pulsesAfterFirstUpdate / pulsesPerFollowingUpdate);
    this.timeOfDayDividerPhase = pulsesAfterFirstUpdate % pulsesPerFollowingUpdate;
    for (let update = 0; update < updateCount; update += 1) this.incrementTimeOfDay();
  }

  protected readPortAExternalInputs(portAOutput: number, portBOutput: number): number {
    void portAOutput;
    void portBOutput;
    return 0xff;
  }

  protected readPortBExternalInputs(portAOutput: number, portBOutput: number): number {
    void portAOutput;
    void portBOutput;
    return 0xff;
  }

  protected onPortAOutputChanged(pins: number): void {
    void pins;
  }

  protected onPortBOutputChanged(pins: number): void {
    void pins;
  }

  protected onPortControlOutputChanged(high: boolean): void {
    void high;
  }

  protected onSerialOutputChanged(clockHigh: boolean, dataHigh: boolean): void {
    void clockHigh;
    void dataHigh;
  }

  private installRegisterMap(): void {
    this.mapRegister(CIA_REGISTER.portA, {
      read: () => this.readPortA(),
      write: (index, value) => this.writePort(index, value, 'a'),
    });
    this.mapRegister(CIA_REGISTER.portB, {
      read: () => this.readPortB(),
      write: (index, value) => this.writePort(index, value, 'b'),
    });
    this.mapRegister(CIA_REGISTER.dataDirectionA, {
      write: (index, value) => this.writePort(index, value, 'a'),
    });
    this.mapRegister(CIA_REGISTER.dataDirectionB, {
      write: (index, value) => this.writePort(index, value, 'b'),
    });

    this.mapTimerRegisters(this.timerA, CIA_REGISTER.timerALow, CIA_REGISTER.timerAHigh);
    this.mapTimerRegisters(this.timerB, CIA_REGISTER.timerBLow, CIA_REGISTER.timerBHigh);

    for (const register of TOD_REGISTER_ORDER) {
      this.mapRegister(register, {
        read: () => this.readTimeOfDay(register),
        write: (_index, value) => this.writeTimeOfDay(register, value),
      });
    }
    this.mapRegister(CIA_REGISTER.serialData, {
      read: (index) => this.readDefault(index),
      write: (index, value) => this.writeSerialData(index, value),
    });
    this.mapRegister(CIA_REGISTER.interruptControl, {
      read: () => this.readInterruptControl(),
      write: (_index, value) => this.writeInterruptControl(value),
    });
    this.mapRegister(CIA_REGISTER.timerAControl, {
      read: (index) => this.readDefault(index),
      write: (index, value) => this.writeTimerControl(this.timerA, index, value, true),
    });
    this.mapRegister(CIA_REGISTER.timerBControl, {
      read: (index) => this.readDefault(index),
      write: (index, value) => this.writeTimerControl(this.timerB, index, value, false),
    });
  }

  private readPortA(): number {
    const portAOutput = this.portAOutputPins;
    return byte(portAOutput & this.readPortAExternalInputs(portAOutput, this.portBOutputPins));
  }

  private readPortB(): number {
    const portBOutput = this.portBOutputPins;
    const value = byte(
      portBOutput & this.readPortBExternalInputs(this.portAOutputPins, portBOutput),
    );
    this.triggerPortControlOutput();
    return value;
  }

  private writePort(index: number, value: number, port: 'a' | 'b'): void {
    this.writeDefault(index, value);
    if (port === 'a') this.onPortAOutputChanged(this.portAOutputPins);
    else {
      this.onPortBOutputChanged(this.portBOutputPins);
      if (index === CIA_REGISTER.portB) this.triggerPortControlOutput();
    }
  }

  private triggerPortControlOutput(): void {
    this.portControlPulseCyclesRemaining = 1;
    if (!this.portControlOutputHighValue) return;
    this.portControlOutputHighValue = false;
    this.onPortControlOutputChanged(false);
  }

  private tickPortControlOutput(): void {
    if (this.portControlPulseCyclesRemaining === 0) return;
    this.portControlPulseCyclesRemaining -= 1;
    if (this.portControlPulseCyclesRemaining !== 0 || this.portControlOutputHighValue) return;
    this.portControlOutputHighValue = true;
    this.onPortControlOutputChanged(true);
  }

  private composePortOutput(portRegister: number, directionRegister: number): number {
    const output = this.registers[portRegister] ?? 0;
    const direction = this.registers[directionRegister] ?? 0;
    return byte((output & direction) | ~direction);
  }

  private setPinLevel(value: number, mask: number, high: boolean): number {
    return byte(high ? value | mask : value & ~mask);
  }

  private get timerOutputRoutedToPortB(): boolean {
    return (
      (((this.registers[CIA_REGISTER.timerAControl] ?? 0) |
        (this.registers[CIA_REGISTER.timerBControl] ?? 0)) &
        CIA_TIMER_CONTROL_BIT.portBOutput) !==
      0
    );
  }

  private mapTimerRegisters(timer: Mos6526Timer, lowRegister: number, highRegister: number): void {
    this.mapRegister(lowRegister, {
      read: () => byte(timer.counter),
      write: (_index, value) => timer.writeLatchLow(value),
    });
    this.mapRegister(highRegister, {
      read: () => byte(timer.counter >> 8),
      write: (_index, value) => timer.writeLatchHigh(value),
    });
  }

  private writeTimerControl(
    timer: Mos6526Timer,
    registerIndex: number,
    value: number,
    timerA: boolean,
  ): void {
    const storedValue = byte(value & ~CIA_TIMER_CONTROL_BIT.forceLoad);
    this.registers[registerIndex] = storedValue;
    const inputMode = timerA
      ? (value & CIA_TIMER_CONTROL_BIT.timerAInputMode) === 0
        ? CIA_TIMER_B_INPUT_MODE.processorClock
        : CIA_TIMER_B_INPUT_MODE.countPin
      : (value & CIA_TIMER_CONTROL_BIT.timerBInputModeMask) >> 5;
    timer.writeControl(value, inputMode);
    this.onPortBOutputChanged(this.portBOutputPins);
  }

  private synchronizeStoppedTimerStartBit(register: number, running: boolean): void {
    if (running) return;
    const control = this.registers[register] ?? 0;
    this.registers[register] = control & ~CIA_TIMER_CONTROL_BIT.start;
  }

  private writeSerialData(index: number, value: number): void {
    this.writeDefault(index, value);
    const control = this.registers[CIA_REGISTER.timerAControl] ?? 0;
    if ((control & CIA_TIMER_CONTROL_BIT.serialOutputMode) !== 0) {
      this.serialPort.writeOutputByte(value);
    }
  }

  private clockSerialOutput(): void {
    const control = this.registers[CIA_REGISTER.timerAControl] ?? 0;
    if ((control & CIA_TIMER_CONTROL_BIT.serialOutputMode) !== 0) {
      this.serialPort.scheduleOutputClockTransition();
    }
  }

  private readInterruptControl(): number {
    this.lastInterruptControlReadCycle = this.elapsedCycleCount;
    if (this.timerBReadCollision) {
      this.interruptFlags &= ~CIA_INTERRUPT_BIT.timerB;
      this.timerBReadCollision = false;
    }
    if (
      this.model === MOS_6526_MODEL.revised &&
      (this.interruptPipeline & INTERRUPT_PIPELINE.raiseStage0) !== 0 &&
      (this.interruptFlags & CIA_INTERRUPT_BIT.sourceMask) !== 0
    ) {
      this.interruptFlags |= CIA_INTERRUPT_BIT.setOrPending;
    }

    const result = this.interruptFlags;
    this.interruptPipeline |= INTERRUPT_PIPELINE.acknowledgeStage1;
    this.interruptPipeline &= ~INTERRUPT_PIPELINE.raiseStage0;
    if (this.model === MOS_6526_MODEL.revised) {
      this.interruptPipeline &= ~INTERRUPT_PIPELINE.setDataBitStage0;
      const activeFlags =
        this.interruptFlags & (CIA_INTERRUPT_BIT.sourceMask | CIA_INTERRUPT_BIT.setOrPending);
      if (activeFlags !== 0) {
        this.acknowledgedInterruptFlags |= activeFlags | CIA_INTERRUPT_BIT.setOrPending;
      }
    } else {
      this.interruptFlags &= CIA_INTERRUPT_BIT.setOrPending;
      this.newInterruptFlags = 0;
    }
    this.interruptLineAsserted = false;
    return result;
  }

  private writeInterruptControl(value: number): void {
    const selected = value & CIA_INTERRUPT_BIT.sourceMask;
    if ((value & CIA_INTERRUPT_BIT.setOrPending) !== 0) this.interruptMask |= selected;
    else this.interruptMask &= ~selected;

    if (
      (this.interruptFlags & this.interruptMask & CIA_INTERRUPT_BIT.sourceMask) !== 0 &&
      !this.interruptLineAsserted
    ) {
      if (
        this.model === MOS_6526_MODEL.revised &&
        (this.interruptPipeline & INTERRUPT_PIPELINE.readStage1) === 0
      ) {
        this.interruptPipeline |=
          INTERRUPT_PIPELINE.raiseStage0 | INTERRUPT_PIPELINE.setDataBitStage0;
      } else {
        this.interruptPipeline |=
          INTERRUPT_PIPELINE.raiseStage1 | INTERRUPT_PIPELINE.setDataBitStage1;
      }
    } else if (
      this.model === MOS_6526_MODEL.original &&
      (this.interruptPipeline & INTERRUPT_PIPELINE.acknowledgeCancellationWindow) !== 0
    ) {
      // 旧芯片在 ICR 读后的第二个写周期仍允许屏蔽位撤销尚未到达引脚的中断。
      // 这正是 6502 读改写指令的最终写周期；已经拉低的引脚绝不能由此恢复。
      this.interruptPipeline &= ~(
        INTERRUPT_PIPELINE.raiseStage0 | INTERRUPT_PIPELINE.setDataBitStage0
      );
    }
  }

  private raiseInterrupt(source: number): void {
    const normalizedSource = source & CIA_INTERRUPT_BIT.sourceMask;
    this.interruptFlags |= normalizedSource;
    this.newInterruptFlags |= normalizedSource;
    this.acknowledgedInterruptFlags &= ~normalizedSource;
  }

  private runInterruptPipelineCycle(): void {
    if (this.interruptPipeline === 0 && this.newInterruptFlags === 0) return;

    let pipeline = this.interruptPipeline;

    if ((pipeline & INTERRUPT_PIPELINE.acknowledgeStage0) !== 0) {
      if (this.model === MOS_6526_MODEL.revised) {
        this.interruptFlags &= ~this.acknowledgedInterruptFlags;
      } else {
        this.interruptFlags &= ~CIA_INTERRUPT_BIT.setOrPending;
      }
      this.acknowledgedInterruptFlags = 0;
    }
    if ((this.newInterruptFlags & this.interruptMask) !== 0) {
      const followsInterruptControlRead =
        this.lastInterruptControlReadCycle + 1 === this.elapsedCycleCount;
      if (this.model === MOS_6526_MODEL.revised && !followsInterruptControlRead) {
        pipeline |= INTERRUPT_PIPELINE.raiseStage0 | INTERRUPT_PIPELINE.setDataBitStage0;
      } else {
        pipeline |= INTERRUPT_PIPELINE.raiseStage1 | INTERRUPT_PIPELINE.setDataBitStage1;
      }
    }
    if ((pipeline & INTERRUPT_PIPELINE.setDataBitStage0) !== 0) {
      this.interruptFlags |= CIA_INTERRUPT_BIT.setOrPending;
    }
    if ((pipeline & INTERRUPT_PIPELINE.raiseStage0) !== 0) {
      this.interruptLineAsserted = true;
    }

    this.newInterruptFlags = 0;
    this.interruptPipeline = (pipeline << 1) & ~INTERRUPT_PIPELINE_EXPIRED_MASK;
  }

  private runProcessorClockCycle(): void {
    this.elapsedCycleCount += 1;
    this.tickPortControlOutput();
    const serialWorkPending = this.serialPort.cycleWorkPending;
    const serialClockBefore = serialWorkPending ? this.serialClockOutputHigh : true;
    const serialDataBefore = serialWorkPending ? this.serialDataOutputHigh : true;
    if (serialWorkPending && this.serialPort.tickCycle()) {
      this.raiseInterrupt(CIA_INTERRUPT_BIT.serial);
    }
    const timerAUnderflow = this.timerA.tickCycle();
    if (timerAUnderflow) {
      this.synchronizeStoppedTimerStartBit(CIA_REGISTER.timerAControl, this.timerA.running);
      this.raiseInterrupt(CIA_INTERRUPT_BIT.timerA);
      this.clockSerialOutput();
    }
    const cascadeTimerB =
      this.timerB.inputMode === CIA_TIMER_B_INPUT_MODE.timerAUnderflow ||
      (this.timerB.inputMode === CIA_TIMER_B_INPUT_MODE.timerAUnderflowWhileCountHigh &&
        this.countPinHigh);
    if (this.timerB.tickCycle()) {
      this.synchronizeStoppedTimerStartBit(CIA_REGISTER.timerBControl, this.timerB.running);
      this.timerBReadCollision =
        this.model === MOS_6526_MODEL.original &&
        this.lastInterruptControlReadCycle === this.elapsedCycleCount - 1;
      this.raiseInterrupt(CIA_INTERRUPT_BIT.timerB);
    } else {
      this.timerBReadCollision = false;
    }
    if (cascadeTimerB && timerAUnderflow) this.timerB.scheduleExternalStep();
    this.runInterruptPipelineCycle();
    if (
      serialWorkPending &&
      (serialClockBefore !== this.serialClockOutputHigh ||
        serialDataBefore !== this.serialDataOutputHigh)
    ) {
      this.onSerialOutputChanged(this.serialClockOutputHigh, this.serialDataOutputHigh);
    }
  }

  private tickTimeOfDayFromProcessorCycles(cycles: number): void {
    this.timeOfDayCycleAccumulator += cycles;
    const cyclesPerInputPulse = this.processorCyclesPerTimeOfDayInputPulse;
    // TOD 输入只有 50/60 Hz；绝大多数 CPU 周期尚未到下一个边沿。用事件截止
    // 先跳过除法，只在跨过边沿时计算累积脉冲数；相位累加方式保持不变。
    if (this.timeOfDayCycleAccumulator < cyclesPerInputPulse) return;
    const pulses = Math.floor(this.timeOfDayCycleAccumulator / cyclesPerInputPulse);
    this.timeOfDayCycleAccumulator -= pulses * cyclesPerInputPulse;
    this.tickTimeOfDayInput(pulses);
  }

  private readTimeOfDay(register: number): number {
    const index = register - CIA_REGISTER.timeOfDayTenths;
    if (register === CIA_REGISTER.timeOfDayHours && !this.timeOfDayReadLatch) {
      this.timeOfDayReadLatch = this.timeOfDay.slice();
    }
    const source = this.timeOfDayReadLatch ?? this.timeOfDay;
    const value = source[index] ?? 0;
    if (register === CIA_REGISTER.timeOfDayTenths) this.timeOfDayReadLatch = undefined;
    return value;
  }

  private writeTimeOfDay(register: number, value: number): void {
    const index = register - CIA_REGISTER.timeOfDayTenths;
    const control = this.registers[CIA_REGISTER.timerBControl] ?? 0;
    const destination =
      (control & CIA_TIMER_CONTROL_BIT.alarmWrite) !== 0 ? this.alarm : this.timeOfDay;
    destination[index] = this.normalizeTimeOfDayValue(register, value);

    if (destination === this.timeOfDay) {
      if (register === CIA_REGISTER.timeOfDayHours) this.timeOfDayStopped = true;
      if (register === CIA_REGISTER.timeOfDayTenths) {
        if (this.timeOfDayStopped) this.timeOfDayDividerPhase = 0;
        this.timeOfDayStopped = false;
      }
    }
  }

  private normalizeTimeOfDayValue(register: number, value: number): number {
    if (register === CIA_REGISTER.timeOfDayTenths) return value & 0x0f;
    if (register === CIA_REGISTER.timeOfDaySeconds || register === CIA_REGISTER.timeOfDayMinutes) {
      return value & 0x7f;
    }
    return value & (CIA_TIME_OF_DAY.afternoonBit | CIA_TIME_OF_DAY.hourMask);
  }

  private incrementTimeOfDay(): void {
    const tenths = fromBcd(this.timeOfDay[0] ?? 0) + 1;
    if (tenths < CIA_TIME_OF_DAY.tenthsPerSecond) {
      this.timeOfDay[0] = toBcd(tenths);
      this.checkAlarm();
      return;
    }
    this.timeOfDay[0] = 0;

    const seconds = fromBcd(this.timeOfDay[1] ?? 0) + 1;
    if (seconds < CIA_TIME_OF_DAY.secondsPerMinute) {
      this.timeOfDay[1] = toBcd(seconds);
      this.checkAlarm();
      return;
    }
    this.timeOfDay[1] = 0;

    const minutes = fromBcd(this.timeOfDay[2] ?? 0) + 1;
    if (minutes < CIA_TIME_OF_DAY.minutesPerHour) {
      this.timeOfDay[2] = toBcd(minutes);
      this.checkAlarm();
      return;
    }
    this.timeOfDay[2] = 0;
    this.incrementTimeOfDayHour();
    this.checkAlarm();
  }

  private incrementTimeOfDayHour(): void {
    const encoded = this.timeOfDay[3] ?? 0;
    const afternoon = encoded & CIA_TIME_OF_DAY.afternoonBit;
    const hour = Math.max(1, fromBcd(encoded & CIA_TIME_OF_DAY.hourMask));
    if (hour === 11) {
      this.timeOfDay[3] = (afternoon ^ CIA_TIME_OF_DAY.afternoonBit) | toBcd(12);
    } else if (hour === 12) {
      this.timeOfDay[3] = afternoon | toBcd(1);
    } else {
      this.timeOfDay[3] = afternoon | toBcd(hour + 1);
    }
  }

  private checkAlarm(): void {
    if (this.timeOfDay.every((value, index) => value === this.alarm[index])) {
      this.raiseInterrupt(CIA_INTERRUPT_BIT.alarm);
    }
  }
}
