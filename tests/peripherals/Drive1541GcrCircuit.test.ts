// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 1541 GCR 读写电路测试
//
//   文件:       Drive1541GcrCircuit.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  DRIVE_1541_GCR_CIRCUIT,
  Drive1541GcrCircuit,
  type Drive1541GcrCircuitSignals,
} from '../../src/peripherals/drive1541/Drive1541GcrCircuit';

interface CircuitObservation {
  readonly byteReadyData: number[];
  readonly writtenBits: number[];
}

function createCircuit(): {
  readonly circuit: Drive1541GcrCircuit;
  readonly observation: CircuitObservation;
} {
  const observation: CircuitObservation = {
    byteReadyData: [],
    writtenBits: [],
  };
  const signals: Drive1541GcrCircuitSignals = {
    signalByteReady: (dataByte) => observation.byteReadyData.push(dataByte),
    writeFluxBit: (bit) => observation.writtenBits.push(bit),
  };
  return { circuit: new Drive1541GcrCircuit(signals), observation };
}

describe('Drive1541GcrCircuit', () => {
  it('starts weak flux only after the documented no-transition interval', () => {
    const { circuit } = createCircuit();

    circuit.advance(DRIVE_1541_GCR_CIRCUIT.weakFlux.initialDelayMinimumTicks - 1);
    expect(circuit.weakFluxTicksRemaining).toBe(1);

    circuit.advance(1);
    // 固定复位种子的第一次 xorshift32 结果把重复间隔选为 162 个 16 MHz 时钟。
    expect(circuit.weakFluxTicksRemaining).toBe(162);

    circuit.advance(162);
    expect(circuit.weakFluxTicksRemaining).toBe(304);
  });

  it('restarts the no-transition timer when a recorded flux reversal passes the filter', () => {
    const { circuit } = createCircuit();

    circuit.observeRecordedFluxReversal();
    circuit.advance(1);

    // 记录磁通已由 G64 位流量化，电路只需完成最后一个参考时钟的稳定确认。
    expect(circuit.weakFluxTicksRemaining).toBe(312);
    circuit.advance(311);
    expect(circuit.weakFluxTicksRemaining).toBe(1);
  });

  it('replays the same weak-bit byte stream after an electronic reset', () => {
    const { circuit, observation } = createCircuit();

    circuit.advance(8_192);
    const firstRun = observation.byteReadyData.slice();
    expect(new Set(firstRun).size).toBeGreaterThan(1);

    observation.byteReadyData.length = 0;
    circuit.reset();
    circuit.advance(8_192);

    expect(observation.byteReadyData).toEqual(firstRun);
  });

  it('clocks write bits from the selected density divider and reloads every byte', () => {
    const { circuit, observation } = createCircuit();
    circuit.setSpeedZone(2);
    circuit.setWriteDataByte(0xa5);
    circuit.setReadMode(false);

    // 密度输入只改变 UE7 后续重装值，不会异步改写当前计数；首次移位需要 16+14 个
    // 参考时钟，之后稳定为每 56 个参考时钟移出一位。
    circuit.advance(30 + 56 * 15);
    circuit.advance(25);

    expect(observation.writtenBits).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1]);
    expect(observation.byteReadyData).toHaveLength(2);
  });
});
