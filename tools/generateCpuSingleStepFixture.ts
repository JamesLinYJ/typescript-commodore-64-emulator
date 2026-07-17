// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 6502 单步参考样本生成器
//
//   文件:       generateCpuSingleStepFixture.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SINGLE_STEP_SOURCE = {
  byteRangeLength: 65_536,
  commit: '2f6980a2d95757486c7bee24355c360e40e2a224',
  license: 'MIT',
  repository: 'https://github.com/SingleStepTests/65x02',
  samplesPerOpcode: 16,
} as const;

const OPCODE_COUNT = 0x100;
const DOWNLOAD_CONCURRENCY = 8;
const OUTPUT_PATH = resolve('tools/reference/SingleStep6502Samples.json');

interface OpcodeFixture {
  readonly prefixSha256: string;
  readonly samples: readonly unknown[];
}

interface SingleStepFixture {
  readonly opcodes: Readonly<Record<string, OpcodeFixture>>;
  readonly source: typeof SINGLE_STEP_SOURCE;
}

function opcodeHex(opcode: number): string {
  return opcode.toString(16).padStart(2, '0');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function downloadOpcodeFixture(opcode: number): Promise<readonly [string, OpcodeFixture]> {
  const hex = opcodeHex(opcode);
  const url = `https://raw.githubusercontent.com/SingleStepTests/65x02/${SINGLE_STEP_SOURCE.commit}/6502/v1/${hex}.json`;
  const lastByte = SINGLE_STEP_SOURCE.byteRangeLength - 1;
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${lastByte}` },
  });
  if (response.status !== 206) {
    throw new Error(`6502 opcode $${hex} range request returned HTTP ${response.status}.`);
  }
  const contentRange = response.headers.get('content-range');
  if (!contentRange?.startsWith(`bytes 0-${lastByte}/`)) {
    throw new Error(`6502 opcode $${hex} returned invalid Content-Range ${contentRange}.`);
  }

  const prefix = new Uint8Array(await response.arrayBuffer());
  if (prefix.length !== SINGLE_STEP_SOURCE.byteRangeLength) {
    throw new Error(
      `6502 opcode $${hex} prefix contains ${prefix.length} bytes; expected ${SINGLE_STEP_SOURCE.byteRangeLength}.`,
    );
  }
  const samples = extractLeadingJsonObjects(
    new TextDecoder().decode(prefix),
    SINGLE_STEP_SOURCE.samplesPerOpcode,
  );
  return [hex, { prefixSha256: sha256(prefix), samples }];
}

function extractLeadingJsonObjects(input: string, count: number): readonly unknown[] {
  const samples: unknown[] = [];
  let objectStart = -1;
  let objectDepth = 0;
  let insideString = false;
  let escaped = false;

  for (let index = input.indexOf('[') + 1; index < input.length; index += 1) {
    const character = input[index];
    if (insideString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') insideString = false;
      continue;
    }
    if (character === '"') {
      insideString = true;
      continue;
    }
    if (character === '{') {
      if (objectDepth === 0) objectStart = index;
      objectDepth += 1;
      continue;
    }
    if (character !== '}') continue;
    objectDepth -= 1;
    if (objectDepth < 0) throw new Error('Single-step JSON prefix has unbalanced braces.');
    if (objectDepth !== 0 || objectStart < 0) continue;

    samples.push(JSON.parse(input.slice(objectStart, index + 1)) as unknown);
    objectStart = -1;
    if (samples.length === count) return samples;
  }

  throw new Error(`Single-step JSON prefix contains only ${samples.length} complete test objects.`);
}

async function main(): Promise<void> {
  const opcodes: Record<string, OpcodeFixture> = {};
  for (let firstOpcode = 0; firstOpcode < OPCODE_COUNT; firstOpcode += DOWNLOAD_CONCURRENCY) {
    const entries = await Promise.all(
      Array.from(
        { length: Math.min(DOWNLOAD_CONCURRENCY, OPCODE_COUNT - firstOpcode) },
        (_unused, offset) => downloadOpcodeFixture(firstOpcode + offset),
      ),
    );
    for (const [hex, fixture] of entries) opcodes[hex] = fixture;
  }

  const fixture: SingleStepFixture = { opcodes, source: SINGLE_STEP_SOURCE };
  const serialized = `${JSON.stringify(fixture)}\n`;
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, serialized, 'utf8');
  console.log(
    `Generated ${OPCODE_COUNT * SINGLE_STEP_SOURCE.samplesPerOpcode} 6502 single-step samples; SHA-256 ${sha256(new TextEncoder().encode(serialized))}.`,
  );
}

await main();
