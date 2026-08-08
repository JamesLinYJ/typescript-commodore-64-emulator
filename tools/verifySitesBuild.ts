// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Sites 托管产物验证器
//
//   文件:       verifySitesBuild.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const CLIENT_DIRECTORY = resolve('dist/client');
const DIST_DIRECTORY = resolve('dist');
const PUBLIC_DIRECTORY = resolve('public');
const REQUIRED_FILES = [
  resolve('dist/server/index.js'),
  resolve('dist/client/index.html'),
  resolve('dist/.openai/hosting.json'),
] as const;

interface WorkerBuildConfiguration {
  readonly assets?: {
    readonly binding?: string;
    readonly run_worker_first?: boolean;
  };
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function main(): Promise<void> {
  await Promise.all(REQUIRED_FILES.map(async (path) => access(path)));

  const distFiles = await collectFiles(DIST_DIRECTORY);
  const sourceMaps = distFiles.filter((path) => path.endsWith('.map'));
  if (sourceMaps.length > 0) {
    throw new Error(`Sites production archive contains source maps:\n${sourceMaps.join('\n')}`);
  }

  const publicFiles = await collectFiles(PUBLIC_DIRECTORY);
  for (const sourcePath of publicFiles) {
    const assetPath = relative(PUBLIC_DIRECTORY, sourcePath);
    const deployedPath = join(CLIENT_DIRECTORY, assetPath);
    await access(deployedPath);
    const [sourceDigest, deployedDigest] = await Promise.all([
      digest(sourcePath),
      digest(deployedPath),
    ]);
    if (sourceDigest !== deployedDigest) {
      throw new Error(`Sites asset differs from public/${assetPath}.`);
    }
  }

  const indexHtml = await readFile(resolve('dist/client/index.html'), 'utf8');
  if (!indexHtml.includes('__SITE_ORIGIN__/og.png')) {
    throw new Error('Sites HTML is missing the request-origin social-card placeholder.');
  }

  const workerConfiguration = JSON.parse(
    await readFile(resolve('dist/server/wrangler.json'), 'utf8'),
  ) as WorkerBuildConfiguration;
  if (
    workerConfiguration.assets?.binding !== 'ASSETS' ||
    workerConfiguration.assets.run_worker_first !== true
  ) {
    throw new Error('Sites Worker must handle requests before the static asset binding.');
  }

  console.log(
    `PASS Sites build: origin-aware Worker, hosting metadata, ${publicFiles.length} exact assets, 0 source maps.`,
  );
}

await main();
