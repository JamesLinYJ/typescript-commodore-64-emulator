import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ProcessorPort6510 } from '../../src/core/memory/ProcessorPort6510';

describe('ProcessorPort6510 properties', () => {
  it('matches the pin-level DDR equation for every randomized byte combination', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xff }),
        fc.integer({ min: 0, max: 0xff }),
        fc.integer({ min: 0, max: 0xff }),
        (direction, output, input) => {
          const port = new ProcessorPort6510();
          port.writeDirection(direction);
          port.writeData(output);
          port.setInputPins(0xff, input);

          const drivenOutputs = output & direction;
          const connectedInputs = input & ~direction & 0x3f;
          expect(port.dataRegister).toBe((drivenOutputs | connectedInputs) & 0xff);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});
