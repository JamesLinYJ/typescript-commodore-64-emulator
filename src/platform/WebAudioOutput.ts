// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 浏览器音频输出生命周期
//
//   文件:       WebAudioOutput.ts
//
//   日期:       2026年08月09日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

const MAXIMUM_SCHEDULE_AHEAD_SECONDS = 0.25;

export type AudioContextFactory = () => AudioContext | undefined;
export type WebAudioOutputState = 'error' | 'inactive' | 'running' | 'suspended' | 'unavailable';

export interface WebAudioOutputStatus {
  readonly error?: Error;
  readonly state: WebAudioOutputState;
}

export type WebAudioOutputStatusObserver = (status: WebAudioOutputStatus) => void;

function createBrowserAudioContext(): AudioContext | undefined {
  return typeof AudioContext === 'undefined' ? undefined : new AudioContext();
}

export class WebAudioOutput {
  private activationPromise: Promise<WebAudioOutputStatus> | undefined;
  private context: AudioContext | undefined;
  private nextStartTime = 0;
  private readonly statusObservers = new Set<WebAudioOutputStatusObserver>();
  private statusValue: WebAudioOutputStatus = { state: 'inactive' };
  private readonly sources = new Set<AudioBufferSourceNode>();
  private disposed = false;

  private readonly handleActivation = (): void => {
    void this.activate();
  };

  private readonly handleContextStateChange = (): void => {
    this.synchronizeStatusWithContext();
  };

  constructor(
    private readonly activationTarget: EventTarget,
    private readonly contextFactory: AudioContextFactory = createBrowserAudioContext,
  ) {
    activationTarget.addEventListener('pointerdown', this.handleActivation);
    activationTarget.addEventListener('keydown', this.handleActivation);
  }

  get status(): WebAudioOutputStatus {
    return this.statusValue;
  }

  observeStatus(observer: WebAudioOutputStatusObserver): () => void {
    this.statusObservers.add(observer);
    observer(this.statusValue);
    return () => this.statusObservers.delete(observer);
  }

  activate(): Promise<WebAudioOutputStatus> {
    const existingActivation = this.activationPromise;
    if (existingActivation) return existingActivation;

    const activation = this.performActivation();
    this.activationPromise = activation;
    void activation.then(
      () => this.releaseActivation(activation),
      () => this.releaseActivation(activation),
    );
    return activation;
  }

  private async performActivation(): Promise<WebAudioOutputStatus> {
    if (this.disposed) {
      return this.setStatus('error', new Error('Audio output has already been disposed.'));
    }

    let context = this.context;
    if (!context) {
      try {
        context = this.contextFactory();
      } catch (error: unknown) {
        return this.setStatus('error', this.toError(error));
      }
      if (!context) return this.setStatus('unavailable');
      this.context = context;
      context.addEventListener('statechange', this.handleContextStateChange);
    }

    if (context.state === 'suspended') {
      this.setStatus('suspended');
      try {
        await context.resume();
      } catch (error: unknown) {
        return this.setStatus('error', this.toError(error));
      }
    }
    return this.synchronizeStatusWithContext();
  }

  private releaseActivation(activation: Promise<WebAudioOutputStatus>): void {
    if (this.activationPromise === activation) this.activationPromise = undefined;
  }

  enqueue(samples: Float32Array, sampleRate: number): void {
    const context = this.context;
    if (context?.state !== 'running' || samples.length === 0) return;
    if (this.nextStartTime - context.currentTime > MAXIMUM_SCHEDULE_AHEAD_SECONDS) return;

    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.addEventListener('ended', () => this.sources.delete(source), { once: true });
    this.sources.add(source);

    const startTime = Math.max(context.currentTime, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + samples.length / sampleRate;
  }

  clear(): void {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.nextStartTime = this.context?.currentTime ?? 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.activationTarget.removeEventListener('pointerdown', this.handleActivation);
    this.activationTarget.removeEventListener('keydown', this.handleActivation);
    this.clear();
    this.context?.removeEventListener('statechange', this.handleContextStateChange);
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = undefined;
    this.statusObservers.clear();
  }

  private synchronizeStatusWithContext(): WebAudioOutputStatus {
    switch (this.context?.state) {
      case 'running':
        return this.setStatus('running');
      case 'suspended':
        return this.setStatus('suspended');
      case 'closed':
        return this.setStatus('error', new Error('Browser audio context was closed.'));
      default:
        return this.setStatus('inactive');
    }
  }

  private setStatus(state: WebAudioOutputState, error?: Error): WebAudioOutputStatus {
    if (this.statusValue.state === state && this.statusValue.error === error)
      return this.statusValue;
    this.statusValue = error === undefined ? { state } : { error, state };
    for (const observer of this.statusObservers) observer(this.statusValue);
    return this.statusValue;
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
