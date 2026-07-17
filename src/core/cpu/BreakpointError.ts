export class BreakpointError extends Error {
  override readonly name = 'BreakpointError';

  constructor(
    readonly address: number,
    readonly breakpointType: number,
    readonly cyclesConsumed: number,
  ) {
    super(`CPU breakpoint reached at $${address.toString(16).padStart(4, '0')}.`);
  }
}
