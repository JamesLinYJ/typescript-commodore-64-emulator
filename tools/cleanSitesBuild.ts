// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - Sites 托管产物清理器
//
//   文件:       cleanSitesBuild.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const DIST_DIRECTORY = resolve('dist');

if (basename(DIST_DIRECTORY) !== 'dist') {
  throw new Error(`Refusing to clean unexpected Sites output path: ${DIST_DIRECTORY}`);
}

await rm(DIST_DIRECTORY, { recursive: true, force: true });
