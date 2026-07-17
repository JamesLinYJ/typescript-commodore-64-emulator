export class Float32RingBuffer {
  private readonly values: Float32Array;
  private readIndex = 0;
  private writeIndex = 0;
  private length = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('Ring buffer capacity must be a positive integer.');
    }
    this.values = new Float32Array(capacity);
  }

  get size(): number {
    return this.length;
  }

  push(value: number): void {
    this.values[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.length === this.capacity) {
      this.readIndex = (this.readIndex + 1) % this.capacity;
    } else {
      this.length += 1;
    }
  }

  drain(maximumLength = this.length): Float32Array {
    const count = Math.min(this.length, Math.max(0, Math.trunc(maximumLength)));
    const output = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      output[index] = this.values[this.readIndex] ?? 0;
      this.readIndex = (this.readIndex + 1) % this.capacity;
    }
    this.length -= count;
    return output;
  }

  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.length = 0;
  }
}
