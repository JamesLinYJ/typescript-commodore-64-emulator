import type { C64Firmware } from '../core/memory/C64Memory';

export interface FirmwareUrls {
  readonly basic: string;
  readonly character: string;
  readonly kernal: string;
}

export type BinaryFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const DEFAULT_FIRMWARE_URLS: FirmwareUrls = {
  basic: './firmware/basic.901226-01.bin',
  character: './firmware/characters.901225-01.bin',
  kernal: './firmware/kernal.901227-03.bin',
};

export async function fetchBinary(
  url: string,
  fetcher: BinaryFetcher = fetch,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetcher(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`Unable to load ${url}: HTTP ${response.status} ${response.statusText}.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function loadFirmware(
  urls: FirmwareUrls = DEFAULT_FIRMWARE_URLS,
  fetcher: BinaryFetcher = fetch,
  signal?: AbortSignal,
): Promise<C64Firmware> {
  const [basic, character, kernal] = await Promise.all([
    fetchBinary(urls.basic, fetcher, signal),
    fetchBinary(urls.character, fetcher, signal),
    fetchBinary(urls.kernal, fetcher, signal),
  ]);
  return { basic, character, kernal };
}
