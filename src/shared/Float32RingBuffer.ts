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

  push(value: number): boolean {
    const overflowed = this.length === this.capacity;
    this.values[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (overflowed) {
      this.readIndex = (this.readIndex + 1) % this.capacity;
    } else {
      this.length += 1;
    }
    return overflowed;
  }

  /** 批量写入并返回为保持有界容量而丢弃的最旧样本数。 */
  pushMany(values: Float32Array): number {
    const valueCount = values.length;
    if (valueCount === 0) return 0;
    const dropped = Math.max(0, this.length + valueCount - this.capacity);

    if (valueCount >= this.capacity) {
      this.values.set(values.subarray(valueCount - this.capacity));
      this.readIndex = 0;
      this.writeIndex = 0;
      this.length = this.capacity;
      return dropped;
    }

    const firstLength = Math.min(valueCount, this.capacity - this.writeIndex);
    this.values.set(values.subarray(0, firstLength), this.writeIndex);
    this.values.set(values.subarray(firstLength), 0);
    this.writeIndex = (this.writeIndex + valueCount) % this.capacity;
    if (dropped > 0) this.readIndex = (this.readIndex + dropped) % this.capacity;
    this.length = Math.min(this.capacity, this.length + valueCount);
    return dropped;
  }

  drain(maximumLength = this.length): Float32Array {
    const count = Math.min(this.length, Math.max(0, Math.trunc(maximumLength)));
    const output = new Float32Array(count);
    this.pullInto(output);
    return output;
  }

  /** 无分配地把已有样本读入调用方缓冲区，返回实际写入数量。 */
  pullInto(destination: Float32Array): number {
    const count = Math.min(this.length, destination.length);
    const firstLength = Math.min(count, this.capacity - this.readIndex);
    destination.set(this.values.subarray(this.readIndex, this.readIndex + firstLength));
    destination.set(this.values.subarray(0, count - firstLength), firstLength);
    this.readIndex = (this.readIndex + count) % this.capacity;
    this.length -= count;
    return count;
  }

  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.length = 0;
  }
}
