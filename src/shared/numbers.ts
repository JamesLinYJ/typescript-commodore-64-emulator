export const BYTE_MASK = 0xff;
export const WORD_MASK = 0xffff;

export function byte(value: number): number {
  return value & BYTE_MASK;
}

export function word(value: number): number {
  return value & WORD_MASK;
}

export function hex(value: number, width = 2): string {
  return word(value).toString(16).toUpperCase().padStart(width, '0');
}

export function toBcd(value: number): number {
  const normalized = Math.max(0, Math.trunc(value)) % 100;
  return ((Math.trunc(normalized / 10) << 4) | (normalized % 10)) & BYTE_MASK;
}

export function fromBcd(value: number): number {
  const normalized = byte(value);
  return (normalized >> 4) * 10 + (normalized & 0x0f);
}

export function signedByte(value: number): number {
  const normalized = byte(value);
  return normalized < 0x80 ? normalized : normalized - 0x100;
}
