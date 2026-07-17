import { describe, expect, it } from 'vitest';

import { Float32RingBuffer } from '../../src/shared/Float32RingBuffer';

describe('Float32RingBuffer', () => {
  it('preserves order across wrapping and drops the oldest values on overflow', () => {
    const buffer = new Float32RingBuffer(3);
    buffer.push(1);
    buffer.push(2);
    expect([...buffer.drain(1)]).toEqual([1]);
    buffer.push(3);
    buffer.push(4);
    buffer.push(5);

    expect(buffer.size).toBe(3);
    expect([...buffer.drain()]).toEqual([3, 4, 5]);
  });

  it('rejects an invalid capacity', () => {
    expect(() => new Float32RingBuffer(0)).toThrow(RangeError);
  });
});
