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

  it('streams blocks into caller-owned storage and reports deterministic overflow', () => {
    const buffer = new Float32RingBuffer(4);
    expect(buffer.pushMany(Float32Array.of(1, 2, 3))).toBe(0);
    expect(buffer.pushMany(Float32Array.of(4, 5, 6))).toBe(2);
    const output = new Float32Array(3);

    expect(buffer.pullInto(output)).toBe(3);
    expect([...output]).toEqual([3, 4, 5]);
    expect(buffer.size).toBe(1);
    expect([...buffer.drain()]).toEqual([6]);

    buffer.push(7);
    expect(buffer.pushMany(Float32Array.of(8, 9, 10, 11, 12, 13))).toBe(3);
    expect([...buffer.drain()]).toEqual([10, 11, 12, 13]);
  });
});
