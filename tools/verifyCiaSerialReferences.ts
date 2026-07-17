// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CIA 串行外部参考套件
//
//   文件:       verifyCiaSerialReferences.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface CiaSerialReferenceCase {
  readonly arguments: readonly string[];
  readonly name: string;
}

const MAXIMUM_PARALLEL_REFERENCES = 4;
const TSX_CLI_PATH = fileURLToPath(import.meta.resolve('tsx/cli'));
const CIA_REFERENCE_TOOL_PATH = fileURLToPath(new URL('./verifyCiaReference.ts', import.meta.url));

const REFERENCE_CASES: readonly CiaSerialReferenceCase[] = [
  { name: '连续串行输出（旧 CIA）', arguments: ['--serial'] },
  { name: '连续串行输出（新 CIA）', arguments: ['--serial', '--new-cia'] },
  { name: '单次串行输出（旧 CIA）', arguments: ['--serial', '--one-shot'] },
  { name: '单次串行输出（新 CIA）', arguments: ['--serial', '--one-shot', '--new-cia'] },
  { name: 'SDR 首字节装载', arguments: ['--sdr-init'] },
  { name: 'SDR 写入相位', arguments: ['--sdr-delay'] },
  { name: 'SDR 连续双写', arguments: ['--sdr-load'] },
  { name: '连续 ICR 碰撞（旧 CIA）', arguments: ['--serial-icr'] },
  { name: '连续 ICR 碰撞（新 CIA）', arguments: ['--serial-icr', '--new-cia'] },
  { name: '单次 ICR 碰撞（旧 CIA）', arguments: ['--serial-icr', '--one-shot'] },
  {
    name: '单次 ICR 碰撞（新 CIA）',
    arguments: ['--serial-icr', '--one-shot', '--new-cia'],
  },
  { name: '连续零锁存 ICR', arguments: ['--serial-icr2'] },
  { name: '单次零锁存 ICR', arguments: ['--serial-icr2', '--one-shot'] },
];

function runReference(reference: CiaSerialReferenceCase): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [TSX_CLI_PATH, CIA_REFERENCE_TOOL_PATH, ...reference.arguments],
      { stdio: 'inherit' },
    );
    child.once('error', rejectPromise);
    child.once('close', (exitCode, signal) => {
      if (exitCode === 0) {
        resolvePromise();
        return;
      }
      const cause = signal === null ? `退出码 ${String(exitCode)}` : `信号 ${signal}`;
      rejectPromise(new Error(`CIA 外部参考“${reference.name}”失败：${cause}。`));
    });
  });
}

async function main(): Promise<void> {
  let nextReferenceIndex = 0;
  const workerCount = Math.min(MAXIMUM_PARALLEL_REFERENCES, REFERENCE_CASES.length);

  async function runWorker(): Promise<void> {
    while (nextReferenceIndex < REFERENCE_CASES.length) {
      const reference = REFERENCE_CASES[nextReferenceIndex];
      nextReferenceIndex += 1;
      if (reference !== undefined) await runReference(reference);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  console.log(`PASS CIA serial reference suite: ${REFERENCE_CASES.length} fixed VICE programs.`);
}

await main();
