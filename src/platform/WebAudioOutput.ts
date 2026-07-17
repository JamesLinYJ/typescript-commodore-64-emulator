const MAXIMUM_SCHEDULE_AHEAD_SECONDS = 0.25;

export type AudioContextFactory = () => AudioContext | undefined;

function createBrowserAudioContext(): AudioContext | undefined {
  return typeof AudioContext === 'undefined' ? undefined : new AudioContext();
}

export class WebAudioOutput {
  private context: AudioContext | undefined;
  private nextStartTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private disposed = false;

  private readonly activate = (): void => {
    if (this.disposed) return;
    this.context ??= this.contextFactory();
    if (this.context?.state === 'suspended') void this.context.resume();
  };

  constructor(
    private readonly activationTarget: EventTarget,
    private readonly contextFactory: AudioContextFactory = createBrowserAudioContext,
  ) {
    activationTarget.addEventListener('pointerdown', this.activate);
    activationTarget.addEventListener('keydown', this.activate);
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
    this.activationTarget.removeEventListener('pointerdown', this.activate);
    this.activationTarget.removeEventListener('keydown', this.activate);
    this.clear();
    if (this.context) void this.context.close();
    this.context = undefined;
  }
}
