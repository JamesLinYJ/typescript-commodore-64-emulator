// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 内置 PRG 程序目录
//
//   文件:       BundledProgramCatalog.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export interface BundledProgramDescriptor {
  readonly file: string;
  readonly sha256: string;
  readonly title: string;
  readonly year: number;
}

/** 文件哈希同时约束 UI 目录和端到端兼容门禁使用同一份不可变 PRG 输入。 */
export const BUNDLED_PROGRAMS: readonly BundledProgramDescriptor[] = [
  {
    file: 'galaga.prg',
    sha256: '302ba81811de3d9a0f59f76722de2747afd0ca2db8a22ac2d087c06c95d8240d',
    title: 'Galaga',
    year: 1984,
  },
  {
    file: 'colour-galaga.prg',
    sha256: 'c41e39bf4470a31eebcbdae8da1417141b43aae32690d1bf0864575389a9995d',
    title: 'Colour Galaga',
    year: 1984,
  },
  {
    file: 'hellgate.prg',
    sha256: '37292469eae91688afea410bfbb4348ae2b9760145eea231841db4bae0be8c8b',
    title: 'Hellgate',
    year: 1984,
  },
  {
    file: 'matrix.prg',
    sha256: 'fa78e9cbc90cff1212b62368e83db6d6e43489e3b72f3ca040f841e163361740',
    title: 'Matrix',
    year: 1983,
  },
  {
    file: 'rally-speedway-ii.prg',
    sha256: '14f1cd48d86c98328f9cec6d9e9e4b3df6c6704c201339d0c6aead00957e4256',
    title: 'Rally Speedway II',
    year: 1985,
  },
  {
    file: 'void-runner.prg',
    sha256: '08763e514595f42aaecab147b9c215a009a65655b5d95728cb26241858986fed',
    title: 'Voidrunner',
    year: 1987,
  },
];
