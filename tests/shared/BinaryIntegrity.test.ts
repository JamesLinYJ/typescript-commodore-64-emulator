// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 二进制资源完整性校验测试
//
//   文件:       BinaryIntegrity.test.ts
//
//   日期:       2026年08月10日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { assertSha256, sha256Hex } from '../../src/shared/BinaryIntegrity';

const ABC_SHA_256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('binary integrity', () => {
  it('computes the standard SHA-256 digest through the browser-compatible Web Crypto path', async () => {
    const bytes = new TextEncoder().encode('abc');

    await expect(sha256Hex(bytes)).resolves.toBe(ABC_SHA_256);
    await expect(assertSha256(bytes, ABC_SHA_256, 'test asset')).resolves.toBeUndefined();
  });

  it('rejects a changed resource with both actual and expected digests', async () => {
    const changed = new TextEncoder().encode('abd');

    await expect(assertSha256(changed, ABC_SHA_256, 'test asset')).rejects.toThrow(
      /test asset SHA-256 mismatch: received [0-9a-f]{64}, expected ba7816bf/,
    );
  });
});
