// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - VIC-II 精灵碰撞外部参考验证器
//
//   文件:       verifyVicSpriteReference.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { hasBasicReadyPrompt } from '../src/core/basicStartup';
import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

const VICE_TEST_REVISION = 46_176;
const VICE_SPRITE_COLLISION_DIRECTORY =
  `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/` +
  'testprogs/VICII/spritecollisions';

const BASIC_BOOT_FRAME_LIMIT = 300;
const COLLISION_RESULT_FRAME_LIMIT = 120;
const VICE_TEST_RESULT_ADDRESS = 0xd7ff;
const VICE_TEST_SUCCESS_VALUE = 0x00;
const VICE_TEST_FAILURE_VALUE = 0xff;
const VIC_BORDER_COLOR_ADDRESS = 0xd020;
const VIC_COLOR_MASK = 0x0f;
const VICE_TEST_SUCCESS_BORDER_COLOR = 0x05;

interface SpriteCollisionReference {
  readonly cachePath: string;
  readonly checkCount: number;
  readonly description: string;
  readonly fileName: string;
  readonly sha256: string;
}

const SPRITE_COLLISION_REFERENCES = [
  {
    cachePath: resolve('output/reference/sprite-sprite-collision-cycle.prg'),
    checkCount: 6,
    description: 'sprite-to-sprite collision cycle',
    fileName: 'sprite-sprite-collision-cycle.prg',
    sha256: '7c4c02eb0a6e660c091851c7359fa98b58ddcd8db2a738c5028601e01eead885',
  },
  {
    cachePath: resolve('output/reference/sprite-gfx-collision-cycle.prg'),
    checkCount: 39,
    description: 'sprite-to-foreground collision cycle',
    fileName: 'sprite-gfx-collision-cycle.prg',
    sha256: '43658351dd8bff454d3b40e58345ff7bc56f9be2b39d8a41980a6c629dc548df',
  },
] as const satisfies readonly SpriteCollisionReference[];

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

async function readCachedReference(cachePath: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(cachePath));
  } catch (error: unknown) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function validateReferenceHash(
  reference: SpriteCollisionReference,
  bytes: Uint8Array,
  source: string,
): void {
  const actualHash = sha256(bytes);
  if (actualHash !== reference.sha256) {
    throw new Error(
      `VICE ${reference.fileName} SHA-256 mismatch for ${source}: received ${actualHash}.`,
    );
  }
}

async function loadReferenceProgram(reference: SpriteCollisionReference): Promise<Uint8Array> {
  const cached = await readCachedReference(reference.cachePath);
  if (cached) {
    validateReferenceHash(reference, cached, reference.cachePath);
    return cached;
  }

  const url = `${VICE_SPRITE_COLLISION_DIRECTORY}/${reference.fileName}?format=raw`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to download VICE ${reference.fileName}: HTTP ${response.status}.`);
  }

  const downloaded = new Uint8Array(await response.arrayBuffer());
  validateReferenceHash(reference, downloaded, url);
  await mkdir(dirname(reference.cachePath), { recursive: true });
  await writeFile(reference.cachePath, downloaded);
  return downloaded;
}

function bootToBasicReady(scheduler: PalFrameScheduler, memory: C64Memory): number {
  let readyWasAbsent = !hasBasicReadyPrompt(memory);
  for (let frame = 1; frame <= BASIC_BOOT_FRAME_LIMIT; frame += 1) {
    scheduler.runFrame();
    const ready = hasBasicReadyPrompt(memory);
    if (!ready) readyWasAbsent = true;
    else if (readyWasAbsent) return frame;
  }
  throw new Error(`C64 BASIC did not reach READY within ${BASIC_BOOT_FRAME_LIMIT} PAL frames.`);
}

function runCollisionReference(
  firmware: C64Firmware,
  reference: SpriteCollisionReference,
  program: Uint8Array,
): { readonly bootFrames: number; readonly resultFrames: number } {
  const memory = new C64Memory(firmware);
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);
  const bootFrames = bootToBasicReady(scheduler, memory);

  let result: number | undefined;
  const stopObserving = memory.observeWrites(({ address, value }) => {
    if (address === VICE_TEST_RESULT_ADDRESS) result = value;
  });

  installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.basicRun });

  let resultFrames = 0;
  try {
    for (let frame = 1; frame <= COLLISION_RESULT_FRAME_LIMIT; frame += 1) {
      scheduler.runFrame();
      resultFrames = frame;
      if (cpu.isJammed || result !== undefined) break;
    }
  } finally {
    stopObserving();
  }

  if (cpu.isJammed) {
    throw new Error(`VICE ${reference.fileName} entered the 6510 JAM state.`);
  }
  if (result === undefined) {
    throw new Error(
      `VICE ${reference.fileName} did not write its result within ` +
        `${COLLISION_RESULT_FRAME_LIMIT} PAL frames.`,
    );
  }
  if (result === VICE_TEST_FAILURE_VALUE) {
    throw new Error(
      `VICE ${reference.fileName} reported a ${reference.description} mismatch after ` +
        `${reference.checkCount} checks.`,
    );
  }
  if (result !== VICE_TEST_SUCCESS_VALUE) {
    throw new Error(
      `VICE ${reference.fileName} wrote unexpected result ` +
        `$${result.toString(16).padStart(2, '0')}.`,
    );
  }

  const borderColor = memory.read(VIC_BORDER_COLOR_ADDRESS) & VIC_COLOR_MASK;
  if (borderColor !== VICE_TEST_SUCCESS_BORDER_COLOR) {
    throw new Error(
      `VICE ${reference.fileName} result was successful but border color is ${borderColor}; ` +
        `expected ${VICE_TEST_SUCCESS_BORDER_COLOR}.`,
    );
  }

  return { bootFrames, resultFrames };
}

async function main(): Promise<void> {
  const [firmware, ...programs] = await Promise.all([
    loadFirmware(),
    ...SPRITE_COLLISION_REFERENCES.map(loadReferenceProgram),
  ]);

  let totalChecks = 0;
  for (let index = 0; index < SPRITE_COLLISION_REFERENCES.length; index += 1) {
    const reference = SPRITE_COLLISION_REFERENCES[index];
    const program = programs[index];
    if (!reference || !program) {
      throw new Error(`Missing VIC-II sprite collision reference at index ${index}.`);
    }

    const result = runCollisionReference(firmware, reference, program);
    totalChecks += reference.checkCount;
    console.log(
      `PASS VICE ${reference.fileName}: ${reference.checkCount} ${reference.description} checks, ` +
        `BASIC READY in ${result.bootFrames} PAL frames, result in ${result.resultFrames} frames.`,
    );
  }

  console.log(
    `PASS VICE VIC-II sprite collision suite revision ${VICE_TEST_REVISION}: ` +
      `${SPRITE_COLLISION_REFERENCES.length} programs, ${totalChecks} cycle-position checks.`,
  );
}

await main();
