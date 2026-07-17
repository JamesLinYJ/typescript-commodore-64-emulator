// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Ocean CRT 卡带参考验证
//
//   文件:       verifyCartridgeReference.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { createCartridgeFromCrt } from '../src/media/CrtImageParser';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

interface ReferenceAsset {
  readonly cachePath: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly url: string;
}

const OCEAN_REFERENCE: ReferenceAsset = {
  cachePath: resolve('output/reference/vice-testprogs/C64/carts/ocean/ocean.crt'),
  fileName: 'ocean.crt',
  sha256: '426dd453d7702e0333c8b98df9e35ca2513a19184d8f2766b4acc2f8b4a684a5',
  url: 'https://sourceforge.net/p/vice-emu/code/46176/tree/testprogs/C64/carts/ocean/ocean.crt?format=raw',
};
const EXPECTED_BANK_SHA256 = [
  '12c0b361abb12f552bae83fc4f1cd0b646ace5b510bbd53bf9fca371f914b64a',
  '9f1dcbc35c350d6027f98be0f5c8b43b42ca52b7604459c0c42be3aa88913d47',
  '9f1dcbc35c350d6027f98be0f5c8b43b42ca52b7604459c0c42be3aa88913d47',
  '9f1dcbc35c350d6027f98be0f5c8b43b42ca52b7604459c0c42be3aa88913d47',
] as const;
const EXPECTED_SCREEN_COPY_SHA256 =
  'c199b812bf803087360c2737b93b2ab39e7a6ea91af8b4b9a736b1a6308c0d5c';
const OCEAN_BANK_REGISTER = 0xde00;
const OCEAN_ROM_LOW_START = 0x8000;
const OCEAN_ROM_HIGH_START = 0xa000;
const OCEAN_ROM_WINDOW_SIZE = 0x2000;
const REFERENCE_RUN_FRAMES = 120;
const MINIMUM_ROM_PC_FRAME_SAMPLES = 20;
const TEST_ACTIVITY_COUNTER = 0x07e7;
const TEST_SCREEN_COPY_START = 0x0400 + 3 * 40;
const TEST_SCREEN_COPY_SIZE = 0x0100;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBinary(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(path)));
}

async function loadFirmware(): Promise<C64Firmware> {
  const [basic, character, kernal] = await Promise.all([
    readBinary('public/firmware/basic.901226-01.bin'),
    readBinary('public/firmware/characters.901225-01.bin'),
    readBinary('public/firmware/kernal.901227-03.bin'),
  ]);
  return { basic, character, kernal };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readCachedAsset(asset: ReferenceAsset): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(asset.cachePath));
  } catch (error: unknown) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function validateAssetHash(asset: ReferenceAsset, bytes: Uint8Array, source: string): void {
  const actualHash = sha256(bytes);
  if (actualHash !== asset.sha256) {
    throw new Error(`${asset.fileName} SHA-256 mismatch for ${source}: received ${actualHash}.`);
  }
}

async function loadReferenceAsset(asset: ReferenceAsset): Promise<Uint8Array> {
  const cached = await readCachedAsset(asset);
  if (cached) {
    validateAssetHash(asset, cached, asset.cachePath);
    return cached;
  }

  const response = await fetch(asset.url);
  if (!response.ok) {
    throw new Error(`Unable to download ${asset.fileName}: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  validateAssetHash(asset, downloaded, asset.url);
  await mkdir(dirname(asset.cachePath), { recursive: true });
  await writeFile(asset.cachePath, downloaded);
  return downloaded;
}

function readMappedWindow(memory: C64Memory, startAddress: number): Uint8Array {
  return Uint8Array.from({ length: OCEAN_ROM_WINDOW_SIZE }, (_, offset) =>
    memory.read(startAddress + offset),
  );
}

function verifyBanks(memory: C64Memory): void {
  for (let bank = 0; bank < EXPECTED_BANK_SHA256.length; bank += 1) {
    memory.write(OCEAN_BANK_REGISTER, bank);
    const lowHash = sha256(readMappedWindow(memory, OCEAN_ROM_LOW_START));
    const highHash = sha256(readMappedWindow(memory, OCEAN_ROM_HIGH_START));
    const expectedHash = EXPECTED_BANK_SHA256[bank];
    if (lowHash !== expectedHash || highHash !== expectedHash) {
      throw new Error(
        `Ocean bank ${bank} hashes are ROML=${lowHash}, ROMH=${highHash}; ` +
          `expected ${String(expectedHash)} for both mirrored windows.`,
      );
    }
  }
}

async function main(): Promise<void> {
  const [firmware, crtBytes] = await Promise.all([
    loadFirmware(),
    loadReferenceAsset(OCEAN_REFERENCE),
  ]);
  const cartridge = createCartridgeFromCrt(crtBytes);
  const memory = new C64Memory(firmware, { cartridge });
  verifyBanks(memory);

  memory.resetHardware();
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  let romPcFrameSamples = 0;
  for (let frame = 0; frame < REFERENCE_RUN_FRAMES; frame += 1) {
    scheduler.runFrame();
    if (cpu.isJammed) throw new Error('VICE Ocean CRT test entered the 6510 JAM state.');
    const programCounter = cpu.getRegisters().programCounter;
    if (programCounter >= OCEAN_ROM_LOW_START && programCounter < OCEAN_ROM_HIGH_START) {
      romPcFrameSamples += 1;
    }
  }

  if (romPcFrameSamples < MINIMUM_ROM_PC_FRAME_SAMPLES) {
    throw new Error(
      `VICE Ocean CRT test produced only ${romPcFrameSamples} ROM PC frame samples; ` +
        `expected at least ${MINIMUM_ROM_PC_FRAME_SAMPLES}.`,
    );
  }
  const activity = memory.ram[TEST_ACTIVITY_COUNTER] ?? 0;
  if (activity === 0) throw new Error('VICE Ocean CRT test did not advance its activity counter.');
  const screenHash = sha256(
    memory.ram.subarray(TEST_SCREEN_COPY_START, TEST_SCREEN_COPY_START + TEST_SCREEN_COPY_SIZE),
  );
  if (screenHash !== EXPECTED_SCREEN_COPY_SHA256) {
    throw new Error(`VICE Ocean CRT screen copy SHA-256 changed to ${screenHash}.`);
  }

  console.log(
    `PASS VICE Ocean CRT revision 46176: ${EXPECTED_BANK_SHA256.length} exact mirrored banks; ` +
      `${romPcFrameSamples} ROM PC frame samples and activity $${activity.toString(16).padStart(2, '0')} ` +
      `after ${REFERENCE_RUN_FRAMES} PAL frames; SHA-256 ${OCEAN_REFERENCE.sha256}.`,
  );
}

await main();
