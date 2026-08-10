// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 二进制资源完整性校验
//
//   文件:       BinaryIntegrity.ts
//
//   日期:       2026年08月10日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('SHA-256 verification requires the Web Crypto API.');
  }

  // 拷贝为自有 ArrayBuffer，避免 SharedArrayBuffer 视图在不同宿主实现中的兼容差异。
  const digest = await subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function assertSha256(
  bytes: Uint8Array,
  expectedSha256: string,
  resourceName: string,
): Promise<void> {
  if (!SHA_256_HEX_PATTERN.test(expectedSha256)) {
    throw new RangeError(
      `${resourceName} expected SHA-256 must contain exactly 64 lowercase hexadecimal characters.`,
    );
  }

  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${resourceName} SHA-256 mismatch: received ${actualSha256}, expected ${expectedSha256}.`,
    );
  }
}
