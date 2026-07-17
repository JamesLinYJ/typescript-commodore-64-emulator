import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Float32RingBuffer } from '../../src/shared/Float32RingBuffer';

type Operation =
  | { readonly kind: 'push'; readonly value: number }
  | { readonly kind: 'drain'; readonly count: number };

describe('Float32RingBuffer properties', () => {
  it('matches an array oracle for randomized wrap and drain sequences', () => {
    const operation = fc.oneof(
      fc.record({ kind: fc.constant<'push'>('push'), value: fc.integer() }),
      fc.record({ kind: fc.constant<'drain'>('drain'), count: fc.nat(12) }),
    );

    fc.assert(
      fc.property(fc.array(operation, { maxLength: 250 }), (operations: readonly Operation[]) => {
        const capacity = 7;
        const actual = new Float32RingBuffer(capacity);
        const expected: number[] = [];

        for (const current of operations) {
          if (current.kind === 'push') {
            const value = Math.fround(current.value);
            actual.push(value);
            expected.push(value);
            if (expected.length > capacity) expected.shift();
          } else {
            const expectedDrain = expected.splice(0, current.count);
            expect([...actual.drain(current.count)]).toEqual(expectedDrain);
          }
          expect(actual.size).toBe(expected.length);
        }
        expect([...actual.drain()]).toEqual(expected);
      }),
      { numRuns: 300 },
    );
  });
});
