import { describe, expect, it, vi } from 'vitest';

import { TypedEventEmitter } from '../../src/shared/TypedEventEmitter';

interface TestEvents {
  readonly count: number;
  readonly message: string;
}

class TestEmitter extends TypedEventEmitter<TestEvents> {
  publish<EventName extends keyof TestEvents>(
    eventName: EventName,
    payload: TestEvents[EventName],
  ): void {
    this.emit(eventName, payload);
  }
}

describe('TypedEventEmitter', () => {
  it('subscribes, publishes, and unsubscribes without leaking listeners', () => {
    const emitter = new TestEmitter();
    const listener = vi.fn<(value: number) => void>();
    const unsubscribe = emitter.on('count', listener);

    emitter.publish('count', 1);
    unsubscribe();
    emitter.publish('count', 2);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(1);
  });
});
