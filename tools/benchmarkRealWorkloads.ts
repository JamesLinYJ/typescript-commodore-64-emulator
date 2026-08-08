// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 真实整机负载性能基准
//
//   文件:       benchmarkRealWorkloads.ts
//
//   日期:       2026年08月08日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { hasBasicReadyPrompt } from '../src/core/basicStartup';
import { Cpu6502 } from '../src/core/cpu/Cpu6502';
import { C64Memory, type C64Firmware } from '../src/core/memory/C64Memory';
import { SID_MODEL } from '../src/devices/SidModel';
import { installPrg, parsePrg, PRG_START_MODE } from '../src/media/PrgLoader';
import { Commodore1541Drive } from '../src/peripherals/drive1541/Commodore1541Drive';
import { PAL_VIDEO_STANDARD } from '../src/video/palVideoStandard';
import { PalFrameScheduler } from '../src/video/PalFrameScheduler';

interface BenchmarkAsset {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
}

interface BenchmarkSystem {
  readonly cpu: Cpu6502;
  readonly drive: Commodore1541Drive | undefined;
  readonly memory: C64Memory;
  readonly scheduler: PalFrameScheduler;
}

interface AudioMetrics {
  peak: number;
  sampleCount: number;
  squaredSum: number;
}

interface BenchmarkResult {
  readonly audioPeak: number;
  readonly audioRootMeanSquare: number;
  readonly basicBootFrames: number;
  readonly elapsedCycles: number;
  readonly elapsedMilliseconds: number;
  readonly framesPerSecond: number;
  readonly p50FrameMilliseconds: number;
  readonly p95FrameMilliseconds: number;
  readonly p99FrameMilliseconds: number;
  readonly realtimeRatio: number;
  readonly sidSampleCount: number;
}

const FIRMWARE_ASSETS = {
  basic: {
    name: 'BASIC ROM',
    path: 'public/firmware/basic.901226-01.bin',
    sha256: '89878cea0a268734696de11c4bae593eaaa506465d2029d619c0e0cbccdfa62d',
  },
  character: {
    name: 'character ROM',
    path: 'public/firmware/characters.901225-01.bin',
    sha256: 'fd0d53b8480e86163ac98998976c72cc58d5dd8eb824ed7b829774e74213b420',
  },
  kernal: {
    name: 'KERNAL ROM',
    path: 'public/firmware/kernal.901227-03.bin',
    sha256: '83c60d47047d7beab8e5b7bf6f67f80daa088b7a6a27de0d7e016f6484042721',
  },
} as const satisfies Record<keyof C64Firmware, BenchmarkAsset>;

const PROGRAM_ASSET: BenchmarkAsset = {
  name: 'Voidrunner PRG',
  path: 'public/programs/void-runner.prg',
  sha256: '08763e514595f42aaecab147b9c215a009a65655b5d95728cb26241858986fed',
};

const DRIVE_ROM_ASSET: BenchmarkAsset = {
  name: '1541-II DOS ROM',
  path: 'output/reference/1541-II.251968-03.bin',
  sha256: '326c289c38753323d7e8167897447cf61ef35189d82eb8d75210ece949adda7c',
};

const BASIC_BOOT_FRAME_LIMIT = 300;
const PROGRAM_SETTLE_FRAMES = 120;
const BENCHMARK_WARMUP_FRAMES = 30;
const BENCHMARK_MEASURED_FRAMES = 180;
const SID_REGISTER_BASE = 0xd400;
const SID_WAVEFORM_MASK = 0xf0;

async function readVerifiedAsset(asset: BenchmarkAsset): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(resolve(asset.path)));
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== asset.sha256) {
    throw new Error(
      `${asset.name} SHA-256 mismatch: received ${actualHash}, expected ${asset.sha256}.`,
    );
  }
  return bytes;
}

async function loadFirmware(): Promise<C64Firmware> {
  const [basic, character, kernal] = await Promise.all([
    readVerifiedAsset(FIRMWARE_ASSETS.basic),
    readVerifiedAsset(FIRMWARE_ASSETS.character),
    readVerifiedAsset(FIRMWARE_ASSETS.kernal),
  ]);
  return { basic, character, kernal };
}

async function loadDriveRom(): Promise<Uint8Array> {
  try {
    return await readVerifiedAsset(DRIVE_ROM_ASSET);
  } catch (error: unknown) {
    throw new Error(
      `--drive requires the fixed ${DRIVE_ROM_ASSET.name} at ${DRIVE_ROM_ASSET.path}; ` +
        'run npm run verify:drive once to fetch and verify it.',
      { cause: error },
    );
  }
}

async function createBenchmarkSystem(
  firmware: C64Firmware,
  withDrive: boolean,
): Promise<BenchmarkSystem> {
  const memory = new C64Memory(firmware, { sidModel: SID_MODEL.mos6581 });
  const cpu = new Cpu6502(memory);
  const drive = withDrive
    ? new Commodore1541Drive({
        deviceNumber: 8,
        iecBus: memory.iecBus,
        rom: await loadDriveRom(),
      })
    : undefined;
  const scheduler = new PalFrameScheduler(cpu, memory, drive ? [drive.clock] : []);
  return { cpu, drive, memory, scheduler };
}

function bootToBasicReady(system: BenchmarkSystem): number {
  let readyWasAbsent = !hasBasicReadyPrompt(system.memory);
  for (let frame = 1; frame <= BASIC_BOOT_FRAME_LIMIT; frame += 1) {
    runFrameAndDrainAudio(system);
    const ready = hasBasicReadyPrompt(system.memory);
    if (!ready) readyWasAbsent = true;
    else if (readyWasAbsent) return frame;
  }
  throw new Error(`C64 BASIC did not reach READY within ${BASIC_BOOT_FRAME_LIMIT} PAL frames.`);
}

function activateSid(memory: C64Memory): void {
  // 三个不同波形和频率都经过高共振低通，确保测量覆盖振荡器、包络、非线性滤波和重采样。
  const voices = [
    [0x34, 0x12, 0x00, 0x08, 0x21, 0x24, 0xf8],
    [0x45, 0x23, 0x55, 0x05, 0x41, 0x15, 0xe6],
    [0x56, 0x34, 0x00, 0x00, 0x11, 0x36, 0xd7],
  ] as const;
  for (let voice = 0; voice < voices.length; voice += 1) {
    const registers = voices[voice];
    if (registers === undefined) throw new Error(`SID voice ${voice} setup is missing.`);
    for (let register = 0; register < registers.length; register += 1) {
      writeSidRegister(memory, voice * registers.length + register, registers[register] ?? 0);
    }
  }
  writeSidRegister(memory, 0x15, 0x07);
  writeSidRegister(memory, 0x16, 0x90);
  writeSidRegister(memory, 0x17, 0xf7);
  writeSidRegister(memory, 0x18, 0x1f);
}

function writeSidRegister(memory: C64Memory, register: number, value: number): void {
  memory.write(SID_REGISTER_BASE + register, value);
}

function assertActiveSid(memory: C64Memory, warmupAudio: AudioMetrics): void {
  for (const voice of [0, 1, 2] as const) {
    const state = memory.sid.getVoice(voice);
    if ((state.control & SID_WAVEFORM_MASK) === 0 || state.envelope === 0) {
      throw new Error(`SID voice ${voice + 1} became inactive during benchmark warmup.`);
    }
  }
  if (memory.sid.masterVolume === 0 || memory.sid.filterCutoff === 0) {
    throw new Error('SID filter or master volume became inactive during benchmark warmup.');
  }
  if (warmupAudio.sampleCount === 0 || warmupAudio.peak === 0) {
    throw new Error('Active SID workload produced no audible samples during warmup.');
  }
}

function createAudioMetrics(): AudioMetrics {
  return { peak: 0, sampleCount: 0, squaredSum: 0 };
}

function accumulateAudio(metrics: AudioMetrics, samples: Float32Array): void {
  metrics.sampleCount += samples.length;
  for (const sample of samples) {
    metrics.peak = Math.max(metrics.peak, Math.abs(sample));
    metrics.squaredSum += sample * sample;
  }
}

function runFrameAndDrainAudio(system: BenchmarkSystem, audio?: AudioMetrics): void {
  system.scheduler.runFrame();
  const samples = system.memory.sid.drainSamples();
  if (audio !== undefined) accumulateAudio(audio, samples);
  if (system.cpu.isJammed) {
    throw new Error(
      `Voidrunner entered the 6510 JAM state at PC $${system.cpu.pc.toString(16).padStart(4, '0')}.`,
    );
  }
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
  const value = sortedValues[index];
  if (value === undefined) throw new Error('Benchmark percentile requires at least one frame.');
  return value;
}

async function runBenchmark(withDrive: boolean): Promise<BenchmarkResult> {
  const [firmware, program] = await Promise.all([loadFirmware(), readVerifiedAsset(PROGRAM_ASSET)]);
  const system = await createBenchmarkSystem(firmware, withDrive);
  try {
    const basicBootFrames = bootToBasicReady(system);
    installPrg(parsePrg(program), system.memory, system.cpu, {
      startMode: PRG_START_MODE.basicRun,
    });
    for (let frame = 0; frame < PROGRAM_SETTLE_FRAMES; frame += 1) {
      runFrameAndDrainAudio(system);
    }

    activateSid(system.memory);
    const warmupAudio = createAudioMetrics();
    for (let frame = 0; frame < BENCHMARK_WARMUP_FRAMES; frame += 1) {
      runFrameAndDrainAudio(system, warmupAudio);
    }
    assertActiveSid(system.memory, warmupAudio);

    const audio = createAudioMetrics();
    const frameTimes = new Float64Array(BENCHMARK_MEASURED_FRAMES);
    const startCycles = system.scheduler.machine.elapsedCycles;
    const startedAt = performance.now();
    let previousFrameAt = startedAt;
    for (let frame = 0; frame < BENCHMARK_MEASURED_FRAMES; frame += 1) {
      runFrameAndDrainAudio(system, audio);
      const frameCompletedAt = performance.now();
      frameTimes[frame] = frameCompletedAt - previousFrameAt;
      previousFrameAt = frameCompletedAt;
    }
    const elapsedMilliseconds = previousFrameAt - startedAt;
    const elapsedCycles = system.scheduler.machine.elapsedCycles - startCycles;
    const expectedCycles =
      BENCHMARK_MEASURED_FRAMES *
      PAL_VIDEO_STANDARD.timing.rasterLineCount *
      PAL_VIDEO_STANDARD.timing.cpuCyclesPerRasterLine;
    // runFrame 在 VIC 帧事件后等当前 6510 指令完成才返回，区间两端各自可能位于
    // 不同的指令相位；帧数仍由 VIC 精确界定，周期差必须小于一条光栅线。
    const cycleSkew = Math.abs(elapsedCycles - expectedCycles);
    if (cycleSkew >= PAL_VIDEO_STANDARD.timing.cpuCyclesPerRasterLine) {
      throw new Error(
        `Benchmark advanced ${elapsedCycles.toLocaleString('en-US')} cycles; ` +
          `expected ${expectedCycles.toLocaleString('en-US')} within one raster line.`,
      );
    }

    const framesPerSecond = (BENCHMARK_MEASURED_FRAMES * 1000) / elapsedMilliseconds;
    const sortedFrameTimes = Array.from(frameTimes).sort((left, right) => left - right);
    return {
      audioPeak: audio.peak,
      audioRootMeanSquare:
        audio.sampleCount === 0 ? 0 : Math.sqrt(audio.squaredSum / audio.sampleCount),
      basicBootFrames,
      elapsedCycles,
      elapsedMilliseconds,
      framesPerSecond,
      p50FrameMilliseconds: percentile(sortedFrameTimes, 0.5),
      p95FrameMilliseconds: percentile(sortedFrameTimes, 0.95),
      p99FrameMilliseconds: percentile(sortedFrameTimes, 0.99),
      realtimeRatio: framesPerSecond / PAL_VIDEO_STANDARD.timing.refreshRateHz,
      sidSampleCount: audio.sampleCount,
    };
  } finally {
    system.drive?.dispose();
  }
}

function parseWithDriveArgument(arguments_: readonly string[]): boolean {
  for (const argument of arguments_) {
    if (argument !== '--drive') throw new RangeError(`Unsupported benchmark argument ${argument}.`);
  }
  return arguments_.includes('--drive');
}

const withDrive = parseWithDriveArgument(process.argv.slice(2));
const result = await runBenchmark(withDrive);
console.log(
  [
    `Workload: Voidrunner + active MOS 6581${withDrive ? ' + Commodore 1541-II' : ''}`,
    `BASIC boot: ${result.basicBootFrames} PAL frames`,
    `Program settle: ${PROGRAM_SETTLE_FRAMES} PAL frames`,
    `Warmup / measured: ${BENCHMARK_WARMUP_FRAMES} / ${BENCHMARK_MEASURED_FRAMES} PAL frames`,
    `Elapsed: ${result.elapsedMilliseconds.toFixed(2)} ms`,
    `Throughput: ${result.framesPerSecond.toFixed(2)} frames/s`,
    `Frame time p50/p95/p99: ${result.p50FrameMilliseconds.toFixed(2)} / ${result.p95FrameMilliseconds.toFixed(2)} / ${result.p99FrameMilliseconds.toFixed(2)} ms`,
    `Real-time ratio: ${result.realtimeRatio.toFixed(2)}x`,
    `CPU/VIC cycles: ${result.elapsedCycles.toLocaleString('en-US')}`,
    `SID samples: ${result.sidSampleCount.toLocaleString('en-US')} (peak ${result.audioPeak.toFixed(6)}, RMS ${result.audioRootMeanSquare.toFixed(6)})`,
  ].join('\n'),
);
