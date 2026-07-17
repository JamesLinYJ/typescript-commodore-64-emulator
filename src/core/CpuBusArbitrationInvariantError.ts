// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - CPU 总线仲裁不变量错误
//
//   文件:       CpuBusArbitrationInvariantError.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

export type CpuBusArbitrationAccess = 'read' | 'write';

export interface CpuBusArbitrationConflict {
  readonly access: CpuBusArbitrationAccess;
  readonly address: number;
  readonly rasterCycle: number;
  readonly rasterLine: number;
}

// AEC 为低时 VIC-II 已经取得 φ2 总线；CPU 访问若仍然发生，说明调度时序本身已失真。
export class CpuBusArbitrationInvariantError extends Error {
  readonly conflict: CpuBusArbitrationConflict;

  constructor(conflict: CpuBusArbitrationConflict) {
    const address = conflict.address.toString(16).toUpperCase().padStart(4, '0');
    super(
      `CPU ${conflict.access} at $${address} overlapped VIC-II AEC-low ownership ` +
        `on raster ${conflict.rasterLine}, cycle ${conflict.rasterCycle}.`,
    );
    this.name = 'CpuBusArbitrationInvariantError';
    this.conflict = conflict;
  }
}
