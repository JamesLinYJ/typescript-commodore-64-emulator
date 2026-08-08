// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 整机仿真性能基准
//
//   文件:       benchmarkEmulation.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { performance } from 'node:perf_hooks';

import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { byte } from '../src/shared/numbers';
import { PAL_VIDEO_STANDARD } from '../src/video/palVideoStandard';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

const BENCHMARK_START_ADDRESS = 0x0200;
const BENCHMARK_WARMUP_FRAMES = 20;
const BENCHMARK_MEASURED_FRAMES = 120;
const JMP_ABSOLUTE_OPCODE = 0x4c;

interface BenchmarkResult {
  readonly elapsedMilliseconds: number;
  readonly elapsedCycles: number;
  readonly emulatedMegahertz: number;
  readonly framesPerSecond: number;
  readonly medianFrameMilliseconds: number;
  readonly p95FrameMilliseconds: number;
  readonly p99FrameMilliseconds: number;
  readonly realtimeRatio: number;
}

function createBenchmarkFirmware(): C64Firmware {
  const basic = new Uint8Array(0x2000).fill(JMP_ABSOLUTE_OPCODE);
  const character = new Uint8Array(0x1000);
  const kernal = new Uint8Array(0x2000).fill(JMP_ABSOLUTE_OPCODE);
  kernal[0x1ffc] = byte(BENCHMARK_START_ADDRESS);
  kernal[0x1ffd] = byte(BENCHMARK_START_ADDRESS >> 8);
  return { basic, character, kernal };
}

function createBenchmarkSystem(): {
  readonly cpu: Cpu6502;
  readonly memory: C64Memory;
  readonly scheduler: PalFrameScheduler;
} {
  const memory = new C64Memory(createBenchmarkFirmware());
  // 固定的三周期 JMP 循环让每次运行执行完全相同的 CPU 总线序列；其它芯片仍逐周期推进。
  memory.ram[BENCHMARK_START_ADDRESS] = JMP_ABSOLUTE_OPCODE;
  memory.ram[BENCHMARK_START_ADDRESS + 1] = byte(BENCHMARK_START_ADDRESS);
  memory.ram[BENCHMARK_START_ADDRESS + 2] = byte(BENCHMARK_START_ADDRESS >> 8);
  const cpu = new Cpu6502(memory);
  return { cpu, memory, scheduler: new PalFrameScheduler(cpu, memory) };
}

function runBenchmark(): BenchmarkResult {
  const { scheduler } = createBenchmarkSystem();
  for (let frame = 0; frame < BENCHMARK_WARMUP_FRAMES; frame += 1) scheduler.runFrame();

  const frameTimes = new Float64Array(BENCHMARK_MEASURED_FRAMES);
  const startCycles = scheduler.machine.elapsedCycles;
  const startedAt = performance.now();
  let previousFrameAt = startedAt;
  for (let frame = 0; frame < BENCHMARK_MEASURED_FRAMES; frame += 1) {
    scheduler.runFrame();
    const frameCompletedAt = performance.now();
    frameTimes[frame] = frameCompletedAt - previousFrameAt;
    previousFrameAt = frameCompletedAt;
  }
  const elapsedMilliseconds = previousFrameAt - startedAt;
  const elapsedCycles = scheduler.machine.elapsedCycles - startCycles;
  const expectedCycles =
    BENCHMARK_MEASURED_FRAMES *
    PAL_VIDEO_STANDARD.timing.rasterLineCount *
    PAL_VIDEO_STANDARD.timing.cpuCyclesPerRasterLine;
  if (elapsedCycles !== expectedCycles) {
    throw new Error(
      `Benchmark advanced ${elapsedCycles.toLocaleString('en-US')} cycles; expected ${expectedCycles.toLocaleString('en-US')}.`,
    );
  }
  const framesPerSecond = (BENCHMARK_MEASURED_FRAMES * 1000) / elapsedMilliseconds;
  const sortedFrameTimes = Array.from(frameTimes).sort((left, right) => left - right);

  return {
    elapsedCycles,
    elapsedMilliseconds,
    emulatedMegahertz: elapsedCycles / elapsedMilliseconds / 1000,
    framesPerSecond,
    medianFrameMilliseconds: percentile(sortedFrameTimes, 0.5),
    p95FrameMilliseconds: percentile(sortedFrameTimes, 0.95),
    p99FrameMilliseconds: percentile(sortedFrameTimes, 0.99),
    realtimeRatio: framesPerSecond / PAL_VIDEO_STANDARD.timing.refreshRateHz,
  };
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  const value = sortedValues[index];
  if (value === undefined) throw new Error('Benchmark percentile requires at least one sample.');
  return value;
}

const result = runBenchmark();
console.log(
  [
    `PAL frames: ${BENCHMARK_MEASURED_FRAMES}`,
    `Elapsed: ${result.elapsedMilliseconds.toFixed(2)} ms`,
    `Throughput: ${result.framesPerSecond.toFixed(2)} frames/s`,
    `Frame time p50/p95/p99: ${result.medianFrameMilliseconds.toFixed(2)} / ${result.p95FrameMilliseconds.toFixed(2)} / ${result.p99FrameMilliseconds.toFixed(2)} ms`,
    `CPU/VIC cycles: ${result.elapsedCycles.toLocaleString('en-US')}`,
    `Emulated clock: ${result.emulatedMegahertz.toFixed(2)} MHz`,
    `Real-time ratio: ${result.realtimeRatio.toFixed(2)}x`,
  ].join('\n'),
);
