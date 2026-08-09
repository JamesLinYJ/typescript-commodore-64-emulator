// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 浏览器音频输出生命周期测试
//
//   文件:       WebAudioOutput.test.ts
//
//   日期:       2026年08月09日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';

import { WebAudioOutput, type WebAudioOutputStatus } from '../../src/platform/WebAudioOutput';

class FakeAudioSource extends EventTarget {
  buffer: AudioBuffer | null = null;
  readonly startTimes: number[] = [];
  readonly stop = vi.fn((): void => {
    this.dispatchEvent(new Event('ended'));
  });

  connect(): void {
    return undefined;
  }

  start(when = 0): void {
    this.startTimes.push(when);
  }
}

class FakeAudioContext extends EventTarget {
  currentTime = 0;
  readonly destination = {} as AudioDestinationNode;
  readonly sources: FakeAudioSource[] = [];
  state: AudioContextState = 'suspended';
  resumeError: Error | undefined;
  readonly close = vi.fn((): Promise<void> => {
    this.state = 'closed';
    return Promise.resolve();
  });
  readonly resume = vi.fn((): Promise<void> => {
    if (this.resumeError) return Promise.reject(this.resumeError);
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
    return Promise.resolve();
  });

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    const samples = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => samples,
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeAudioSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
}

function asAudioContext(context: FakeAudioContext): AudioContext {
  return context as unknown as AudioContext;
}

describe('WebAudioOutput', () => {
  it('activates on the first host gesture and publishes state transitions', async () => {
    const target = new EventTarget();
    const context = new FakeAudioContext();
    const factory = vi.fn(() => asAudioContext(context));
    const output = new WebAudioOutput(target, factory);
    const statuses: WebAudioOutputStatus[] = [];
    output.observeStatus((status) => statuses.push(status));

    expect(output.status.state).toBe('inactive');
    expect(factory).not.toHaveBeenCalled();
    target.dispatchEvent(new Event('pointerdown'));

    await vi.waitFor(() => expect(output.status.state).toBe('running'));
    expect(factory).toHaveBeenCalledOnce();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(statuses.map(({ state }) => state)).toEqual(['inactive', 'suspended', 'running']);
    output.dispose();
  });

  it('turns resume rejection into an observable retryable error', async () => {
    const context = new FakeAudioContext();
    context.resumeError = new Error('gesture was rejected');
    const output = new WebAudioOutput(new EventTarget(), () => asAudioContext(context));

    await expect(output.activate()).resolves.toMatchObject({
      error: context.resumeError,
      state: 'error',
    });

    context.resumeError = undefined;
    await expect(output.activate()).resolves.toMatchObject({ state: 'running' });
    expect(context.resume).toHaveBeenCalledTimes(2);
    output.dispose();
  });

  it('coalesces concurrent activation requests into one resume operation', async () => {
    const context = new FakeAudioContext();
    let finishResume: (() => void) | undefined;
    context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishResume = () => {
            context.state = 'running';
            context.dispatchEvent(new Event('statechange'));
            resolve();
          };
        }),
    );
    const output = new WebAudioOutput(new EventTarget(), () => asAudioContext(context));

    const firstActivation = output.activate();
    const secondActivation = output.activate();

    expect(secondActivation).toBe(firstActivation);
    expect(context.resume).toHaveBeenCalledOnce();
    finishResume?.();
    await expect(Promise.all([firstActivation, secondActivation])).resolves.toEqual([
      { state: 'running' },
      { state: 'running' },
    ]);
    output.dispose();
  });

  it('does not create audio buffers before activation or while suspended', () => {
    const context = new FakeAudioContext();
    const output = new WebAudioOutput(new EventTarget(), () => asAudioContext(context));

    output.enqueue(new Float32Array(882), 44_100);
    expect(context.sources).toHaveLength(0);
    output.dispose();
  });

  it('clears scheduled sources and resets the next start to current audio time', async () => {
    const context = new FakeAudioContext();
    context.state = 'running';
    context.currentTime = 10;
    const output = new WebAudioOutput(new EventTarget(), () => asAudioContext(context));
    await output.activate();

    output.enqueue(new Float32Array(882), 44_100);
    context.currentTime = 10.005;
    output.enqueue(new Float32Array(882), 44_100);
    expect(context.sources.map(({ startTimes }) => startTimes[0])).toEqual([10, 10.02]);

    output.clear();
    expect(context.sources.every(({ stop }) => stop.mock.calls.length === 1)).toBe(true);
    context.currentTime = 10.01;
    output.enqueue(new Float32Array(882), 44_100);
    expect(context.sources[2]?.startTimes[0]).toBe(10.01);
    output.dispose();
  });

  it('reports an unavailable Web Audio implementation without throwing', async () => {
    const output = new WebAudioOutput(new EventTarget(), () => undefined);

    await expect(output.activate()).resolves.toEqual({ state: 'unavailable' });
    expect(output.status.state).toBe('unavailable');
    output.dispose();
  });
});
