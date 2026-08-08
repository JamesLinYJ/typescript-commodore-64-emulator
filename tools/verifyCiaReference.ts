// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA 外部参考程序验证器
//
//   文件:       verifyCiaReference.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { BreakpointError } from '../src/core/cpu/BreakpointError';
import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { MOS_6526_MODEL } from '../src/devices/Mos6526Model';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

const USE_NEW_CIA_REFERENCE = process.argv.includes('--new-cia');
const USE_NMI_REFERENCE = process.argv.includes('--nmi');
const USE_SERIAL_REFERENCE = process.argv.includes('--serial');
const USE_SERIAL_ONE_SHOT_REFERENCE = process.argv.includes('--one-shot');
const USE_SERIAL_ICR_REFERENCE = process.argv.includes('--serial-icr');
const USE_SERIAL_ICR2_REFERENCE = process.argv.includes('--serial-icr2');
const USE_SDR_INIT_REFERENCE = process.argv.includes('--sdr-init');
const USE_SDR_DELAY_REFERENCE = process.argv.includes('--sdr-delay');
const USE_SDR_LOAD_REFERENCE = process.argv.includes('--sdr-load');
const USE_IRQ_NMI_REFERENCE = process.argv.includes('--irqnmi');

interface CiaReference {
  readonly description: string;
  readonly directory: string;
  readonly entryAddress: number;
  readonly file: string;
  readonly sha256: string;
}

function selectReference(): CiaReference {
  if (USE_IRQ_NMI_REFERENCE) {
    if (!USE_NEW_CIA_REFERENCE) {
      throw new Error('The irqnmi-new reference requires --new-cia.');
    }
    if (
      USE_NMI_REFERENCE ||
      USE_SERIAL_REFERENCE ||
      USE_SERIAL_ONE_SHOT_REFERENCE ||
      USE_SERIAL_ICR_REFERENCE ||
      USE_SERIAL_ICR2_REFERENCE ||
      USE_SDR_INIT_REFERENCE ||
      USE_SDR_DELAY_REFERENCE ||
      USE_SDR_LOAD_REFERENCE
    ) {
      throw new Error('The IRQ/NMI collision reference cannot be combined with another mode.');
    }
    return {
      description: 'IRQ/NMI collision timing',
      directory: 'interrupts/irqnmi',
      entryAddress: 0x080d,
      file: 'irqnmi-new.prg',
      sha256: '456385627b9a8bca0c82354fb41e0ca9b697c7a306614b0321b2c1035a1b1e84',
    };
  }

  const sdrReferences = [
    USE_SDR_INIT_REFERENCE
      ? {
          description: 'SDR initial load timing',
          directory: 'CIA/shiftregister',
          entryAddress: 0x080d,
          file: 'cia-sdr-init.prg',
          sha256: '70d104e67505fed82678aa1a74d9244c68d5f90ad53e1e83213744bf257646a5',
        }
      : undefined,
    USE_SDR_DELAY_REFERENCE
      ? {
          description: 'SDR phase-dependent load timing',
          directory: 'CIA/shiftregister',
          entryAddress: 0x080d,
          file: 'cia-sdr-delay.prg',
          sha256: '8492306ab49fa3e2073888ec4e7f2cde0d597da3677d0517da989b76aa15649b',
        }
      : undefined,
    USE_SDR_LOAD_REFERENCE
      ? {
          description: 'back-to-back SDR load timing',
          directory: 'CIA/shiftregister',
          entryAddress: 0x0820,
          file: 'cia-sdr-load.prg',
          sha256: 'd5815f5d086c85c38d0aa534bd3fd07541aac84893fd7c6b5b5d642733fa8c22',
        }
      : undefined,
  ].filter((reference): reference is CiaReference => reference !== undefined);

  const serialReferenceFamilyCount =
    sdrReferences.length +
    Number(USE_SERIAL_REFERENCE) +
    Number(USE_SERIAL_ICR_REFERENCE) +
    Number(USE_SERIAL_ICR2_REFERENCE);
  if (serialReferenceFamilyCount > 1) {
    throw new Error('Select exactly one CIA serial reference mode per invocation.');
  }
  const sdrReference = sdrReferences[0];
  if (sdrReference !== undefined) return sdrReference;

  if (USE_SERIAL_ICR_REFERENCE) {
    const mode = USE_SERIAL_ONE_SHOT_REFERENCE ? 'oneshot' : 'continues';
    const model = USE_NEW_CIA_REFERENCE ? 'new' : 'old';
    const key = `${mode}-${model}` as const;
    const hashes = {
      'continues-new': '13aef56ebe23f2479b391365ad7323ed3dbab4274fb89f61ae8037f5ef123f5b',
      'continues-old': '5792a6d0b7f89127c9776c019677fb5c9d4703127a2369a397ec90bd8841e712',
      'oneshot-new': '454db36e746e7998d328c0f1a870401ca7a4756522b633f7ddd14172d33aab13',
      'oneshot-old': 'e6ad7e42b681ba36ce9d0e851028efbf6ac89b541d943cc54b95fcfcc471a9fe',
    } as const;
    return {
      description: `${mode} ICR read collision`,
      directory: 'CIA/shiftregister',
      entryAddress: 0x080d,
      file: `cia-icr-test-${mode}-${model}.prg`,
      sha256: hashes[key],
    };
  }

  if (USE_SERIAL_ICR2_REFERENCE) {
    if (USE_NEW_CIA_REFERENCE) {
      throw new Error('The CIA ICR2 reference is model-independent; omit --new-cia.');
    }
    const mode = USE_SERIAL_ONE_SHOT_REFERENCE ? 'oneshot' : 'continues';
    return {
      description: `${mode} zero-latch ICR mask collision`,
      directory: 'CIA/shiftregister',
      entryAddress: 0x080d,
      file: `cia-icr-test2-${mode}.prg`,
      sha256:
        mode === 'oneshot'
          ? '6907fb8ff69290b40e0f379ffcba5f06c5a323f7fae6c66a39582f3bf1f57201'
          : 'a424b1b1fb67df15c5a999df74e9ccd8b335cbec3dc5630701c433ab576e5662',
    };
  }

  if (USE_SERIAL_REFERENCE) {
    const mode = USE_SERIAL_ONE_SHOT_REFERENCE ? 'oneshot' : 'continues';
    const model = USE_NEW_CIA_REFERENCE ? 'new' : 'old';
    const key = `${mode}-${model}` as const;
    const hashes = {
      'continues-new': 'b1f8979653573921fd8853e9287bdc22f4927543d51afc316fd3a5796814c530',
      'continues-old': '1fe10a886c2e7529c0983377f67db90b092cf2bd962e4f105f35666892fc3031',
      'oneshot-new': 'dfb9cafbdcf17d72e7709e5ef3ae4a1267ba58ab45ba5df50c8c1e2a98dca128',
      'oneshot-old': 'f46a4ef085bfc6b7eed801f89755abc0455ff471c605dc7de95063cc02c03b58',
    } as const;
    return {
      description: `${mode} serial shift register`,
      directory: 'CIA/shiftregister',
      entryAddress: 0x080d,
      file: `cia-sp-test-${mode}-${model}.prg`,
      sha256: hashes[key],
    };
  }

  if (USE_NMI_REFERENCE) {
    return USE_NEW_CIA_REFERENCE
      ? {
          description: 'NMI interrupt timing',
          directory: 'interrupts/cia-int',
          entryAddress: 0x0815,
          file: 'cia-int-nmi-new.prg',
          sha256: '6fc2ad961300e1c9a383a6bb0abaccc63f34a5398898fb5ccb56b7ea1dfbd93e',
        }
      : {
          description: 'NMI interrupt timing',
          directory: 'interrupts/cia-int',
          entryAddress: 0x0815,
          file: 'cia-int-nmi.prg',
          sha256: 'ba92e7dc23e83f93bb63caa9a05fcd3c413fd870d5847e0bfc4d44940b2b44eb',
        };
  }
  return USE_NEW_CIA_REFERENCE
    ? {
        description: 'IRQ interrupt timing',
        directory: 'interrupts/cia-int',
        entryAddress: 0x0815,
        file: 'cia-int-irq-new.prg',
        sha256: '7c70e4bfa02e87a019c58ea5d7d28f2559f16a635c6701fa68c4bb013dc9cbb7',
      }
    : {
        description: 'IRQ interrupt timing',
        directory: 'interrupts/cia-int',
        entryAddress: 0x0815,
        file: 'cia-int-irq.prg',
        sha256: '70bc8f3ecadd374d095a476c6c614d4d7461111e31b614c5f48cf37acf3018e2',
      };
}

const REFERENCE = selectReference();
const REFERENCE_FILE = REFERENCE.file;
const VICE_TEST_REVISION = 46_176;
const REFERENCE_URL = `https://sourceforge.net/p/vice-emu/code/${VICE_TEST_REVISION}/tree/testprogs/${REFERENCE.directory}/${REFERENCE_FILE}?format=raw`;
const CACHE_PATH = resolve(`output/reference/${REFERENCE_FILE}`);
const VICE_TEST_EXIT_PORT = 0xd7ff;
const BOOT_FRAME_COUNT = 200;
const TEST_FRAME_LIMIT = 1_000;
const TRACE_CAPACITY = 24;
const RESULT_ROWS = [3, 4, 7, 8, 11, 12, 15, 16, 19, 20] as const;
const IRQ_NMI_SCREEN_ADDRESS = 0x0400;
const IRQ_NMI_REFERENCE_ADDRESS = 0x0ab4;
const IRQ_NMI_RESULT_SIZE = 0x0300;
const IRQ_NMI_RESULT_ROW_WIDTH = 40;
const IRQ_NMI_NMI_COLUMN_OFFSET = 20;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function formatCiaResults(memory: C64Memory): string {
  if (USE_IRQ_NMI_REFERENCE) {
    const actual = memory.copyRam(IRQ_NMI_SCREEN_ADDRESS, IRQ_NMI_RESULT_SIZE);
    const expected = memory.copyRam(IRQ_NMI_REFERENCE_ADDRESS, IRQ_NMI_RESULT_SIZE);
    const differences: string[] = [];
    for (let offset = 0; offset < IRQ_NMI_RESULT_SIZE; offset += 1) {
      const actualValue = actual[offset] ?? 0;
      const expectedValue = expected[offset] ?? 0;
      if (actualValue === expectedValue) continue;
      const row = Math.floor(offset / IRQ_NMI_RESULT_ROW_WIDTH);
      const column = offset % IRQ_NMI_RESULT_ROW_WIDTH;
      const source =
        column >= IRQ_NMI_NMI_COLUMN_OFFSET
          ? `NMI y=${column - IRQ_NMI_NMI_COLUMN_OFFSET}`
          : `IRQ y=${column}`;
      differences.push(
        `x=${row} ${source}:$${actualValue.toString(16).padStart(2, '0')}!=` +
          `$${expectedValue.toString(16).padStart(2, '0')}`,
      );
      if (differences.length >= TRACE_CAPACITY) break;
    }
    return `first IRQ/NMI matrix differences: ${differences.join(' ') || 'none'}`;
  }

  if (USE_SDR_DELAY_REFERENCE) {
    const bytes = memory.copyRam(0x2000, 21 * 2);
    const values = Array.from({ length: 21 }, (_unused, index) => {
      const low = bytes[index * 2] ?? 0;
      const high = bytes[index * 2 + 1] ?? 0;
      return `$${((high << 8) | low).toString(16).padStart(4, '0')}`;
    });
    return `Timer B samples: ${values.join(' ')}`;
  }

  if (USE_SDR_INIT_REFERENCE || USE_SDR_LOAD_REFERENCE) {
    const rows = Array.from({ length: 5 }, (_unused, row) => {
      const screenCodes = memory.copyRam(0x0400 + row * 40, 4);
      return Array.from(screenCodes, (value) => {
        if (value >= 1 && value <= 26) return String.fromCharCode(64 + value);
        if (value >= 0x30 && value <= 0x39) return String.fromCharCode(value);
        return `[$${value.toString(16).padStart(2, '0')}]`;
      }).join('');
    });
    return `screen timing samples: ${rows.join(' ')}`;
  }

  if (USE_SERIAL_REFERENCE) {
    const differences: string[] = [];
    const actualScreen = memory.copyRam(0x0400, 0x0300);
    const expectedScreen = memory.copyRam(0x1000, 0x0300);
    for (let offset = 0; offset < 0x0300 && differences.length < TRACE_CAPACITY; offset += 1) {
      const actual = actualScreen[offset] ?? 0;
      const expected = expectedScreen[offset] ?? 0;
      if (actual !== expected) {
        differences.push(
          `$${(0x0400 + offset).toString(16).padStart(4, '0')}:$${actual.toString(16).padStart(2, '0')}!=` +
            `$${expected.toString(16).padStart(2, '0')}`,
        );
      }
    }
    return `first screen/reference differences: ${differences.join(' ') || 'none'}`;
  }

  return RESULT_ROWS.map((row) => {
    const values = Array.from(memory.copyRam(0x0400 + row * 40, 24), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    return `row${row}=${values}`;
  }).join(' ');
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

async function loadReferenceProgram(): Promise<Uint8Array> {
  try {
    const cached = new Uint8Array(await readFile(CACHE_PATH));
    if (sha256(cached) === REFERENCE.sha256) return cached;
  } catch {
    // 首次运行参考测试时缓存尚不存在，这是正常路径。
  }

  const response = await fetch(REFERENCE_URL);
  if (!response.ok) {
    throw new Error(`Unable to download the VICE CIA test: HTTP ${response.status}.`);
  }
  const downloaded = new Uint8Array(await response.arrayBuffer());
  const actualHash = sha256(downloaded);
  if (actualHash !== REFERENCE.sha256) {
    throw new Error(`VICE CIA test SHA-256 mismatch: received ${actualHash}.`);
  }
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, downloaded);
  return downloaded;
}

async function main(): Promise<void> {
  const [firmware, program] = await Promise.all([loadFirmware(), loadReferenceProgram()]);
  const ciaModel = USE_NEW_CIA_REFERENCE ? MOS_6526_MODEL.revised : MOS_6526_MODEL.original;
  const memory = new C64Memory(firmware, {
    ciaModels: { cia1: ciaModel, cia2: ciaModel },
  });
  const cpu = new Cpu6502(memory);
  const scheduler = new PalFrameScheduler(cpu, memory);

  for (let frame = 0; frame < BOOT_FRAME_COUNT; frame += 1) scheduler.runFrame();
  installPrg(parsePrg(program), memory, cpu, { startMode: PRG_START_MODE.none });
  cpu.pc = REFERENCE.entryAddress;

  const instructionTrace: string[] = [];
  cpu.setInstructionObserver((address, opcode) => {
    instructionTrace.push(
      `$${address.toString(16).padStart(4, '0')}:$${opcode.toString(16).padStart(2, '0')}`,
    );
    if (instructionTrace.length > TRACE_CAPACITY) instructionTrace.shift();
  });
  for (let address = 0x0000; address < 0x0200; address += 1) cpu.setBreakpoint(address);

  let exitCode: number | undefined;
  const stopObserving = memory.observeWrites(({ address, value }) => {
    if (address === VICE_TEST_EXIT_PORT) exitCode = value;
  });

  let frames = 0;
  try {
    while (exitCode === undefined && frames < TEST_FRAME_LIMIT) {
      scheduler.runFrame(undefined, true);
      frames += 1;
    }
  } catch (error: unknown) {
    if (error instanceof BreakpointError) {
      throw new Error(
        `VICE CIA reference ${REFERENCE_FILE} branched into zero page at $${error.address.toString(16).padStart(4, '0')}. Recent instructions: ${instructionTrace.join(' ')}`,
        { cause: error },
      );
    }
    throw error;
  }
  stopObserving();

  if (exitCode === undefined) {
    throw new Error(
      `VICE CIA reference ${REFERENCE_FILE} did not report a result within ${TEST_FRAME_LIMIT} PAL frames (PC=$${cpu.pc.toString(16).padStart(4, '0')}). Recent instructions: ${instructionTrace.join(' ')}`,
    );
  }
  if (exitCode !== 0) {
    throw new Error(
      `VICE CIA reference ${REFERENCE_FILE} failed with exit code $${exitCode.toString(16).padStart(2, '0')} after ${frames} PAL frames. ${formatCiaResults(memory)}`,
    );
  }

  console.log(
    `PASS VICE ${REFERENCE_FILE} (${ciaModel} ${REFERENCE.description}/PAL reference): ${frames} PAL frames, ${scheduler.machine.elapsedCycles.toLocaleString('en-US')} total cycles.`,
  );
}

await main();
