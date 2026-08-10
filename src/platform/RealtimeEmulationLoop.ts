// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 实时整机推进与输出调度
//
//   文件:       RealtimeEmulationLoop.ts
//
//   日期:       2026年08月10日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { BreakpointError } from '../core/cpu/BreakpointError';
import type { Cpu6502 } from '../core/cpu/Cpu6502';
import type { C64ClockedPeripheral } from '../core/C64Machine';
import type { C64Memory } from '../core/memory/C64Memory';
import { PalFrameScheduler } from '../core/PalFrameScheduler';
import { TypedEventEmitter } from '../shared/TypedEventEmitter';
import { PAL_VIDEO_STANDARD } from '../video/palVideoStandard';
import { browserFrameClock } from './BrowserFrameClock';

const PAL_FRAME_DURATION_MS = 1000 / PAL_VIDEO_STANDARD.timing.refreshRateHz;
const MAXIMUM_CATCH_UP_FRAMES = 3;

export type EmulationLoopState = 'paused' | 'running';

export interface RealtimeFrameClock {
  now(): number;
  request(callback: (timestamp: number) => void): number;
  cancel(handle: number): void;
}

export interface RealtimeVideoSink {
  beginFrame(backgroundColor: number): void;
  presentFrame(): void;
  writeRasterLine(visibleRow: number, pixels: Uint32Array): void;
}

export interface RealtimeAudioSink {
  clear(): void;
  enqueue(samples: Float32Array, sampleRate: number): void;
}

export interface RealtimeEmulationLoopOptions {
  readonly audioSink: RealtimeAudioSink;
  readonly clock?: RealtimeFrameClock;
  readonly clockedPeripherals?: readonly C64ClockedPeripheral[];
  readonly videoSink: RealtimeVideoSink;
}

interface EmulationLoopEvents {
  readonly breakpoint: BreakpointError;
  readonly error: Error;
  readonly frame: { readonly frameNumber: number; readonly renderTime: number };
  readonly state: EmulationLoopState;
}

/**
 * 唯一的实时推进所有者。PAL pacing 只决定何时请求下一完整硬件帧，不替代 VIC-II
 * 帧边界，也不跳过硬件周期；视频和音频仅消费已经生成的最终输出。
 */
export class RealtimeEmulationLoop extends TypedEventEmitter<EmulationLoopEvents> {
  readonly scheduler: PalFrameScheduler;

  private readonly audioSink: RealtimeAudioSink;
  private readonly clock: RealtimeFrameClock;
  private readonly videoSink: RealtimeVideoSink;
  private readonly rasterLinePixels = new Uint32Array(PAL_VIDEO_STANDARD.output.width);
  private state: EmulationLoopState = 'paused';
  private frameRequest: number | undefined;
  private previousTimestamp = 0;
  private accumulatedTime = PAL_FRAME_DURATION_MS;
  private frameNumber = 0;

  private readonly handleAnimationFrame = (timestamp: number): void => {
    if (this.state !== 'running') return;

    const elapsed = Math.min(
      PAL_VIDEO_STANDARD.timing.maximumFrameDeltaMs,
      Math.max(0, timestamp - this.previousTimestamp),
    );
    this.previousTimestamp = timestamp;
    this.accumulatedTime += elapsed;

    try {
      let completedFrames = 0;
      while (
        this.accumulatedTime >= PAL_FRAME_DURATION_MS &&
        completedFrames < MAXIMUM_CATCH_UP_FRAMES
      ) {
        this.executeFrame(true);
        this.accumulatedTime -= PAL_FRAME_DURATION_MS;
        completedFrames += 1;
      }
      if (completedFrames === MAXIMUM_CATCH_UP_FRAMES) this.accumulatedTime = 0;
    } catch (error: unknown) {
      this.pause();
      if (error instanceof BreakpointError) this.emit('breakpoint', error);
      else this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }

    if (this.state === 'running') this.scheduleNextFrame();
  };

  constructor(
    cpu: Cpu6502,
    private readonly memory: C64Memory,
    options: RealtimeEmulationLoopOptions,
  ) {
    super();
    this.audioSink = options.audioSink;
    this.clock = options.clock ?? browserFrameClock;
    this.videoSink = options.videoSink;
    this.scheduler = new PalFrameScheduler(cpu, memory, options.clockedPeripherals ?? []);
  }

  get currentState(): EmulationLoopState {
    return this.state;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  start(): void {
    if (this.state === 'running') return;
    this.state = 'running';
    this.previousTimestamp = this.clock.now();
    this.accumulatedTime = PAL_FRAME_DURATION_MS;
    this.emit('state', this.state);
    this.scheduleNextFrame();
  }

  pause(): void {
    this.audioSink.clear();
    if (this.state === 'paused') return;
    this.state = 'paused';
    if (this.frameRequest !== undefined) this.clock.cancel(this.frameRequest);
    this.frameRequest = undefined;
    this.emit('state', this.state);
  }

  toggle(): void {
    if (this.isRunning) this.pause();
    else this.start();
  }

  stepInstruction(): number {
    if (this.isRunning) throw new Error('Pause the emulator before stepping an instruction.');
    const cycles = this.scheduler.executeInstruction(false);
    this.discardNonRealtimeAudio();
    return cycles;
  }

  stepFrame(): void {
    if (this.isRunning) throw new Error('Pause the emulator before stepping a frame.');
    this.executeFrame(false);
  }

  resetTiming(): void {
    this.audioSink.clear();
    this.accumulatedTime = PAL_FRAME_DURATION_MS;
    this.scheduler.resetTiming();
    this.discardNonRealtimeAudio();
  }

  resetCpu(): number {
    const cycles = this.scheduler.resetCpu();
    this.discardNonRealtimeAudio();
    return cycles;
  }

  dispose(): void {
    this.pause();
    this.clearListeners();
  }

  private scheduleNextFrame(): void {
    this.frameRequest = this.clock.request(this.handleAnimationFrame);
  }

  private executeFrame(realtimeAudio: boolean): void {
    const startedAt = this.clock.now();
    this.videoSink.beginFrame(this.memory.vic.palette[0]);
    this.scheduler.runFrame((rasterLine) => this.writeVisibleRasterLine(rasterLine), true);
    this.videoSink.presentFrame();

    const samples = this.memory.sid.drainSamples();
    if (realtimeAudio && samples.length > 0) {
      this.audioSink.enqueue(samples, this.memory.sid.sampleRateHz);
    }
    this.frameNumber += 1;
    this.emit('frame', {
      frameNumber: this.frameNumber,
      renderTime: this.clock.now() - startedAt,
    });
  }

  private writeVisibleRasterLine(rasterLine: number): void {
    const { firstVisibleRaster, lastVisibleRasterExclusive } = PAL_VIDEO_STANDARD.output;
    if (rasterLine < firstVisibleRaster || rasterLine >= lastVisibleRasterExclusive) return;
    this.memory.vic.copyRasterLinePixelsTo(this.rasterLinePixels, 0);
    this.videoSink.writeRasterLine(rasterLine - firstVisibleRaster, this.rasterLinePixels);
  }

  private discardNonRealtimeAudio(): void {
    this.memory.sid.drainSamples();
  }
}
