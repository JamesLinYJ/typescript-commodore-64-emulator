export class CpuBusCycleInvariantError extends Error {
  constructor(
    readonly declaredCycles: number,
    readonly observedCycles: number,
  ) {
    super(
      `CPU operation declared ${declaredCycles} cycles but emitted ${observedCycles} bus cycles.`,
    );
    this.name = 'CpuBusCycleInvariantError';
  }
}
