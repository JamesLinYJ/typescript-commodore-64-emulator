export interface FrameClock {
  now(): number;
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export const browserFrameClock: FrameClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};
