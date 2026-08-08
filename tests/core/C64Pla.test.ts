// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 PLA 地址译码测试
//
//   文件:       C64Pla.test.ts
//
//   日期:       2026年07月16日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import {
  C64Pla,
  C64_CARTRIDGE_MODE,
  C64_PLA_TARGET,
  c64PlaConfigurationCodeForSignals,
  type C64PlaInputs,
  type C64PlaTarget,
} from '../../src/core/memory/C64Pla';

interface PlaReadWindows {
  readonly address8000: C64PlaTarget;
  readonly addressA000: C64PlaTarget;
  readonly addressD000: C64PlaTarget;
  readonly addressE000: C64PlaTarget;
}

const R = C64_PLA_TARGET.ram;
const B = C64_PLA_TARGET.basicRom;
const K = C64_PLA_TARGET.kernalRom;
const C = C64_PLA_TARGET.characterRom;
const I = C64_PLA_TARGET.io;
const L = C64_PLA_TARGET.cartridgeLow;
const H = C64_PLA_TARGET.cartridgeHigh;
const O = C64_PLA_TARGET.openBus;

// 顺序与 VICE c64meminit.c 的 32 项真值表一致：低三位依次是
// LORAM、HIRAM、CHAREN，高两位表示被拉低的 /EXROM、/GAME。
const EXPECTED_READ_WINDOWS: readonly PlaReadWindows[] = [
  { address8000: R, addressA000: R, addressD000: R, addressE000: R },
  { address8000: R, addressA000: R, addressD000: C, addressE000: R },
  { address8000: R, addressA000: R, addressD000: C, addressE000: K },
  { address8000: R, addressA000: B, addressD000: C, addressE000: K },
  { address8000: R, addressA000: R, addressD000: R, addressE000: R },
  { address8000: R, addressA000: R, addressD000: I, addressE000: R },
  { address8000: R, addressA000: R, addressD000: I, addressE000: K },
  { address8000: R, addressA000: B, addressD000: I, addressE000: K },
  { address8000: R, addressA000: R, addressD000: R, addressE000: R },
  { address8000: R, addressA000: R, addressD000: C, addressE000: R },
  { address8000: R, addressA000: R, addressD000: C, addressE000: K },
  { address8000: L, addressA000: B, addressD000: C, addressE000: K },
  { address8000: R, addressA000: R, addressD000: R, addressE000: R },
  { address8000: R, addressA000: R, addressD000: I, addressE000: R },
  { address8000: R, addressA000: R, addressD000: I, addressE000: K },
  { address8000: L, addressA000: B, addressD000: I, addressE000: K },
  ...Array.from({ length: 8 }, () => ({
    address8000: L,
    addressA000: O,
    addressD000: I,
    addressE000: H,
  })),
  { address8000: R, addressA000: R, addressD000: R, addressE000: R },
  { address8000: R, addressA000: R, addressD000: C, addressE000: R },
  { address8000: R, addressA000: H, addressD000: C, addressE000: K },
  { address8000: L, addressA000: H, addressD000: C, addressE000: K },
  { address8000: R, addressA000: R, addressD000: R, addressE000: R },
  { address8000: R, addressA000: R, addressD000: I, addressE000: R },
  { address8000: R, addressA000: H, addressD000: I, addressE000: K },
  { address8000: L, addressA000: H, addressD000: I, addressE000: K },
];

function inputsForConfigurationCode(code: number): C64PlaInputs {
  return {
    exromLineHigh: (code & 0x08) === 0,
    gameLineHigh: (code & 0x10) === 0,
    processorPort: code & 0x07,
  };
}

describe('C64Pla', () => {
  it('matches every CPU-visible window in the 32-entry C64 PLA truth table', () => {
    expect(EXPECTED_READ_WINDOWS).toHaveLength(32);

    for (const [code, expected] of EXPECTED_READ_WINDOWS.entries()) {
      const inputs = inputsForConfigurationCode(code);
      const pla = new C64Pla(inputs);
      expect(
        c64PlaConfigurationCodeForSignals(
          inputs.gameLineHigh,
          inputs.exromLineHigh,
          inputs.processorPort,
        ),
        `scalar configuration ${code}`,
      ).toBe(code);
      expect(pla.configurationCode, `configuration ${code}`).toBe(code);
      expect(pla.readTarget(0x8000), `configuration ${code}, $8000`).toBe(expected.address8000);
      expect(pla.readTarget(0xa000), `configuration ${code}, $A000`).toBe(expected.addressA000);
      expect(pla.readTarget(0xd000), `configuration ${code}, $D000`).toBe(expected.addressD000);
      expect(pla.readTarget(0xe000), `configuration ${code}, $E000`).toBe(expected.addressE000);
    }
  });

  it('keeps RAM writable behind normal ROMs and disconnects writes in Ultimax holes', () => {
    for (let code = 0; code < 32; code += 1) {
      const pla = new C64Pla(inputsForConfigurationCode(code));
      const ultimax = code >= 16 && code <= 23;

      expect(pla.writeTarget(0x0200), `configuration ${code}, $0200`).toBe(R);
      expect(pla.writeTarget(0xd000), `configuration ${code}, $D000`).toBe(
        ultimax || EXPECTED_READ_WINDOWS[code]?.addressD000 === I ? I : R,
      );
      expect(pla.writeTarget(0x8000), `configuration ${code}, $8000`).toBe(ultimax ? L : R);
      expect(pla.writeTarget(0xa000), `configuration ${code}, $A000`).toBe(ultimax ? O : R);
      expect(pla.writeTarget(0xe000), `configuration ${code}, $E000`).toBe(ultimax ? H : R);
    }
  });

  it('identifies the four physical cartridge-line modes without inverted naming', () => {
    expect(new C64Pla(inputsForConfigurationCode(0)).cartridgeMode).toBe(
      C64_CARTRIDGE_MODE.detached,
    );
    expect(new C64Pla(inputsForConfigurationCode(8)).cartridgeMode).toBe(C64_CARTRIDGE_MODE.game8K);
    expect(new C64Pla(inputsForConfigurationCode(16)).cartridgeMode).toBe(
      C64_CARTRIDGE_MODE.ultimax,
    );
    expect(new C64Pla(inputsForConfigurationCode(24)).cartridgeMode).toBe(
      C64_CARTRIDGE_MODE.game16K,
    );
  });

  it('rejects page numbers outside the 16-bit CPU address space', () => {
    const pla = new C64Pla(inputsForConfigurationCode(0));

    expect(() => pla.readTargetForPage(-1)).toThrow(/outside the 256-page address space/);
    expect(() => pla.writeTargetForPage(0x100)).toThrow(/outside the 256-page address space/);
  });
});
