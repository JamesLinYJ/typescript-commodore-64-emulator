// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 实时整机循环测试
//
//   文件:       RealtimeEmulationLoop.test.ts
//
//   日期:       2026年08月10日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import {
  RealtimeEmulationLoop,
  type RealtimeAudioSink,
  type RealtimeFrameClock,
  type RealtimeVideoSink,
} from '../../src/platform/RealtimeEmulationLoop';
import { PAL_VIDEO_STANDARD } from '../../src/video/palVideoStandard';
import { createC64System } from '../helpers/createTestSystem';

class TestFrameClock implements RealtimeFrameClock {
  nowValue = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, (timestamp: number) => void>();
  readonly cancelled: number[] = [];

  now(): number {
    return this.nowValue;
  }

  request(callback: (timestamp: number) => void): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    this.callbacks.delete(handle);
  }

  fireNext(timestamp: number): void {
    const entry = this.callbacks.entries().next().value as
      readonly [number, (frameTimestamp: number) => void] | undefined;
    if (!entry) throw new Error('No animation frame was scheduled.');
    const [handle, callback] = entry;
    this.callbacks.delete(handle);
    this.nowValue = timestamp;
    callback(timestamp);
  }
}

function createSinks(): {
  readonly audio: RealtimeAudioSink;
  readonly audioClear: ReturnType<typeof vi.fn<() => void>>;
  readonly audioEnqueue: ReturnType<
    typeof vi.fn<(samples: Float32Array, sampleRate: number) => void>
  >;
  readonly beginFrame: ReturnType<typeof vi.fn<(backgroundColor: number) => void>>;
  readonly presentFrame: ReturnType<typeof vi.fn<() => void>>;
  readonly rows: number[];
  readonly video: RealtimeVideoSink;
} {
  const rows: number[] = [];
  const audioClear = vi.fn<() => void>();
  const audioEnqueue = vi.fn<(samples: Float32Array, sampleRate: number) => void>();
  const beginFrame = vi.fn<(backgroundColor: number) => void>();
  const presentFrame = vi.fn<() => void>();
  return {
    audio: { clear: audioClear, enqueue: audioEnqueue },
    audioClear,
    audioEnqueue,
    beginFrame,
    presentFrame,
    rows,
    video: {
      beginFrame,
      presentFrame,
      writeRasterLine: (row, pixels) => {
        expect(pixels).toHaveLength(PAL_VIDEO_STANDARD.output.width);
        rows.push(row);
      },
    },
  };
}

describe('RealtimeEmulationLoop', () => {
  it('owns PAL pacing while Canvas and audio remain passive output sinks', () => {
    const { cpu, memory } = createC64System();
    memory.ram.fill(0xea);
    const clock = new TestFrameClock();
    const { audio, audioClear, audioEnqueue, beginFrame, presentFrame, rows, video } =
      createSinks();
    const runtime = new RealtimeEmulationLoop(cpu, memory, {
      audioSink: audio,
      clock,
      videoSink: video,
    });

    runtime.start();
    clock.fireNext(0);

    expect(beginFrame).toHaveBeenCalledOnce();
    expect(presentFrame).toHaveBeenCalledOnce();
    expect(rows).toHaveLength(PAL_VIDEO_STANDARD.output.height);
    expect(rows[0]).toBe(0);
    expect(rows.at(-1)).toBe(PAL_VIDEO_STANDARD.output.height - 1);
    expect(audioEnqueue).toHaveBeenCalledOnce();

    runtime.pause();
    expect(audioClear).toHaveBeenCalledOnce();
    expect(clock.cancelled).toHaveLength(1);
    runtime.dispose();
  });

  it('discards audio produced by paused instruction and frame stepping', () => {
    const { cpu, memory } = createC64System();
    memory.ram.fill(0xea);
    const clock = new TestFrameClock();
    const { audio, audioEnqueue, presentFrame, video } = createSinks();
    const runtime = new RealtimeEmulationLoop(cpu, memory, {
      audioSink: audio,
      clock,
      videoSink: video,
    });

    runtime.stepInstruction();
    runtime.stepFrame();

    expect(audioEnqueue).not.toHaveBeenCalled();
    expect(memory.sid.pendingSampleCount).toBe(0);
    expect(presentFrame).toHaveBeenCalledOnce();
    runtime.dispose();
  });
});
