// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Canvas 视频输出
//
//   文件:       CanvasRenderer.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { BreakpointError } from '../core/cpu/BreakpointError';
import type { Cpu6502 } from '../core/cpu/Cpu6502';
import type { C64ClockedPeripheral } from '../core/C64Machine';
import type { C64Memory } from '../core/memory/C64Memory';
import { TypedEventEmitter } from '../shared/TypedEventEmitter';
import { CanvasSurface } from './CanvasSurface';
import { browserFrameClock, type FrameClock } from './FrameClock';
import { PAL_VIDEO_STANDARD } from './palVideoStandard';
import { PalFrameScheduler } from './PalFrameScheduler';

const PAL_FRAME_DURATION = 1000 / PAL_VIDEO_STANDARD.timing.refreshRateHz;
const MAX_CATCH_UP_FRAMES = 3;

export type RendererState = 'paused' | 'running';

interface RendererEvents {
  readonly audio: { readonly sampleRate: number; readonly samples: Float32Array };
  readonly breakpoint: BreakpointError;
  readonly error: Error;
  readonly frame: { readonly frameNumber: number; readonly renderTime: number };
  readonly state: RendererState;
}

/**
 * 浏览器输出适配器。
 *
 * VIC-II 已在芯片时钟域完成像素、边框、精灵优先级和碰撞；这里仅复制锁存光栅线并提交
 * ImageData。这样无 Canvas 的测试和服务器环境仍得到完全相同的芯片寄存器行为。
 */
export class CanvasRenderer extends TypedEventEmitter<RendererEvents> {
  readonly surface: CanvasSurface;

  private state: RendererState = 'paused';
  private frameRequest: number | undefined;
  private previousTimestamp = 0;
  private accumulatedTime = PAL_FRAME_DURATION;
  private frameNumber = 0;
  private readonly scheduler: PalFrameScheduler;

  private readonly handleAnimationFrame = (timestamp: number): void => {
    if (this.state !== 'running') return;

    const elapsed = Math.min(
      PAL_VIDEO_STANDARD.timing.maximumFrameDeltaMs,
      Math.max(0, timestamp - this.previousTimestamp),
    );
    this.previousTimestamp = timestamp;
    this.accumulatedTime += elapsed;

    try {
      let renderedFrames = 0;
      while (this.accumulatedTime >= PAL_FRAME_DURATION && renderedFrames < MAX_CATCH_UP_FRAMES) {
        this.renderFrame();
        this.accumulatedTime -= PAL_FRAME_DURATION;
        renderedFrames += 1;
      }
      if (renderedFrames === MAX_CATCH_UP_FRAMES) this.accumulatedTime = 0;
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
    canvas: HTMLCanvasElement,
    private readonly clock: FrameClock = browserFrameClock,
    clockedPeripherals: readonly C64ClockedPeripheral[] = [],
  ) {
    super();
    this.scheduler = new PalFrameScheduler(cpu, memory, clockedPeripherals);
    this.surface = new CanvasSurface(
      canvas,
      PAL_VIDEO_STANDARD.output.width,
      PAL_VIDEO_STANDARD.output.height,
    );
    this.surface.clear(this.memory.vic.palette[0]);
    this.surface.present();
  }

  get currentState(): RendererState {
    return this.state;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  start(): void {
    if (this.state === 'running') return;
    this.state = 'running';
    this.previousTimestamp = this.clock.now();
    this.accumulatedTime = PAL_FRAME_DURATION;
    this.emit('state', this.state);
    this.scheduleNextFrame();
  }

  pause(): void {
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
    return this.scheduler.executeInstruction(false);
  }

  stepFrame(): void {
    if (this.isRunning) throw new Error('Pause the emulator before stepping a frame.');
    this.renderFrame();
  }

  dispose(): void {
    this.pause();
    this.clearListeners();
  }

  resetTiming(): void {
    this.accumulatedTime = PAL_FRAME_DURATION;
    this.scheduler.resetTiming();
  }

  resetCpu(): number {
    return this.scheduler.resetCpu();
  }

  private scheduleNextFrame(): void {
    this.frameRequest = this.clock.request(this.handleAnimationFrame);
  }

  private renderFrame(): void {
    const startedAt = this.clock.now();
    this.surface.clear(this.memory.vic.palette[0]);
    this.scheduler.runFrame((raster) => this.drawRasterLine(raster), true);
    this.surface.present();

    const samples = this.memory.sid.drainSamples();
    if (samples.length > 0) {
      this.emit('audio', { sampleRate: this.memory.sid.sampleRateHz, samples });
    }
    this.frameNumber += 1;
    this.emit('frame', {
      frameNumber: this.frameNumber,
      renderTime: this.clock.now() - startedAt,
    });
  }

  private drawRasterLine(raster: number): void {
    if (
      raster < PAL_VIDEO_STANDARD.output.firstVisibleRaster ||
      raster >= PAL_VIDEO_STANDARD.output.lastVisibleRasterExclusive
    ) {
      return;
    }

    const y = raster - PAL_VIDEO_STANDARD.output.firstVisibleRaster;
    this.memory.vic.copyRasterLinePixelsTo(
      this.surface.frameBuffer.pixels,
      y * PAL_VIDEO_STANDARD.output.width,
    );
  }
}

export const C64_CANVAS_SIZE = {
  width: PAL_VIDEO_STANDARD.output.width,
  height: PAL_VIDEO_STANDARD.output.height,
} as const;
