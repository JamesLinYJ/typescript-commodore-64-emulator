import { describe, expect, it, vi } from 'vitest';

import { fetchBinary, loadFirmware, type BinaryFetcher } from '../../src/platform/FirmwareLoader';

describe('FirmwareLoader', () => {
  it('loads all firmware images through the injected fetcher', async () => {
    const images = new Map<string, Uint8Array>([
      ['/basic.bin', new Uint8Array([1, 2])],
      ['/character.bin', new Uint8Array([3])],
      ['/kernal.bin', new Uint8Array([4, 5])],
    ]);
    const fetcher: BinaryFetcher = vi.fn((input) => {
      const image = images.get(String(input));
      return Promise.resolve(
        image
          ? new Response(image.slice().buffer, { status: 200 })
          : new Response(null, { status: 404 }),
      );
    });

    const firmware = await loadFirmware(
      {
        basic: '/basic.bin',
        character: '/character.bin',
        kernal: '/kernal.bin',
      },
      fetcher,
    );

    expect([...firmware.basic]).toEqual([1, 2]);
    expect([...firmware.character]).toEqual([3]);
    expect([...firmware.kernal]).toEqual([4, 5]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('includes HTTP status details when a request fails', async () => {
    const fetcher: BinaryFetcher = () =>
      Promise.resolve(new Response(null, { status: 503, statusText: 'Unavailable' }));

    await expect(fetchBinary('/missing.bin', fetcher)).rejects.toThrow('HTTP 503 Unavailable');
  });
});
