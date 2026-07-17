// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - C64 Datasette 集成测试
//
//   文件:       C64DatasetteIntegration.test.ts
//
//   日期:       2026年07月17日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { describe, expect, it } from 'vitest';

import { C64Machine } from '../../src/core/C64Machine';
import { Cpu6502 } from '../../src/core/cpu/Cpu6502';
import { C64Memory } from '../../src/core/memory/C64Memory';
import { PROCESSOR_PORT_BIT } from '../../src/core/memory/memoryLayout';
import { CIA_INTERRUPT_BIT, CIA_REGISTER } from '../../src/devices/ciaRegisters';
import { parseTapImage, TAP_IMAGE_LAYOUT } from '../../src/media/TapImageParser';
import { WritableTapImage } from '../../src/media/WritableTapImage';
import { IEC_LINE } from '../../src/peripherals/iec/IecBus';
import { createTestFirmware } from '../helpers/createTestSystem';

function createOnePulseTap(): Uint8Array {
  const bytes = new Uint8Array(TAP_IMAGE_LAYOUT.headerSize + 1);
  bytes.set(Uint8Array.from(TAP_IMAGE_LAYOUT.magic, (character) => character.charCodeAt(0)));
  bytes[TAP_IMAGE_LAYOUT.versionOffset] = 1;
  bytes[TAP_IMAGE_LAYOUT.systemOffset] = 0;
  bytes[TAP_IMAGE_LAYOUT.videoStandardOffset] = 0;
  new DataView(bytes.buffer).setUint32(TAP_IMAGE_LAYOUT.dataLengthOffset, 1, true);
  bytes[TAP_IMAGE_LAYOUT.headerSize] = 1;
  return bytes;
}

describe('C64 Datasette integration', () => {
  it('routes PLAY sense and the active-low motor through the 6510 processor port pins', () => {
    const memory = new C64Memory(createTestFirmware());
    expect(memory.processorPort.dataRegister & PROCESSOR_PORT_BIT.cassetteSense).toBe(
      PROCESSOR_PORT_BIT.cassetteSense,
    );

    memory.datasette.pressPlay();
    expect(memory.processorPort.dataRegister & PROCESSOR_PORT_BIT.cassetteSense).toBe(0);
    expect(memory.datasette.motorActive).toBe(false);

    memory.processorPort.writeDirection(
      memory.processorPort.directionRegister | PROCESSOR_PORT_BIT.cassetteMotor,
    );
    memory.processorPort.writeData(
      memory.processorPort.outputLatch & ~PROCESSOR_PORT_BIT.cassetteMotor,
    );
    expect(memory.datasette.motorActive).toBe(true);
    memory.datasette.pressStop();
    expect(memory.processorPort.dataRegister & PROCESSOR_PORT_BIT.cassetteSense).toBe(
      PROCESSOR_PORT_BIT.cassetteSense,
    );
  });

  it('delivers each tape read pulse to the CIA1 FLAG interrupt source in the hardware clock loop', () => {
    const firmware = createTestFirmware();
    firmware.kernal[0x1ffc] = 0x00;
    firmware.kernal[0x1ffd] = 0xe0;
    const memory = new C64Memory(firmware);
    const cpu = new Cpu6502(memory);
    const machine = new C64Machine(cpu, memory);
    memory.datasette.insertTape(parseTapImage(createOnePulseTap()));
    memory.datasette.pressPlay();
    memory.processorPort.writeDirection(
      memory.processorPort.directionRegister | PROCESSOR_PORT_BIT.cassetteMotor,
    );
    memory.processorPort.writeData(
      memory.processorPort.outputLatch & ~PROCESSOR_PORT_BIT.cassetteMotor,
    );
    memory.cia1.write(
      CIA_REGISTER.interruptControl,
      CIA_INTERRUPT_BIT.setOrPending | CIA_INTERRUPT_BIT.flag,
    );

    machine.advanceHardware(8);
    expect(memory.cia1.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(
      CIA_INTERRUPT_BIT.flag,
    );
  });

  it('combines IEC SRQ and tape READ before the CIA1 FLAG edge detector', () => {
    const memory = new C64Memory(createTestFirmware());
    const serviceRequester = memory.iecBus.attach('SRQ test peripheral');
    const tape = parseTapImage(createOnePulseTap());

    serviceRequester.setPulledLow(IEC_LINE.serviceRequest, true);
    expect(memory.cia1.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(
      CIA_INTERRUPT_BIT.flag,
    );
    expect(memory.cia1.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(0);

    memory.datasette.insertTape(tape);
    memory.datasette.pressPlay();
    memory.processorPort.writeDirection(
      memory.processorPort.directionRegister | PROCESSOR_PORT_BIT.cassetteMotor,
    );
    memory.processorPort.writeData(
      memory.processorPort.outputLatch & ~PROCESSOR_PORT_BIT.cassetteMotor,
    );
    memory.datasette.tick(8);
    expect(memory.cia1.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(0);

    serviceRequester.setPulledLow(IEC_LINE.serviceRequest, false);
    memory.datasette.pressStop();
    memory.datasette.ejectTape();
    memory.datasette.insertTape(tape);
    memory.datasette.pressPlay();
    memory.datasette.tick(8);
    expect(memory.cia1.read(CIA_REGISTER.interruptControl) & CIA_INTERRUPT_BIT.flag).toBe(
      CIA_INTERRUPT_BIT.flag,
    );
  });

  it('routes the 6510 WRITE pin into a writable tape while RECORD and MOTOR are active', () => {
    const memory = new C64Memory(createTestFirmware());
    const cpu = new Cpu6502(memory);
    const machine = new C64Machine(cpu, memory);
    const tape = new WritableTapImage();
    memory.datasette.insertTape(tape);
    memory.datasette.pressRecord();

    const outputMask = PROCESSOR_PORT_BIT.cassetteMotor | PROCESSOR_PORT_BIT.cassetteWrite;
    memory.processorPort.writeDirection(memory.processorPort.directionRegister | outputMask);
    memory.processorPort.writeData(memory.processorPort.outputLatch & ~outputMask);
    machine.advanceHardware(384);
    memory.processorPort.writeData(
      (memory.processorPort.outputLatch & ~PROCESSOR_PORT_BIT.cassetteMotor) |
        PROCESSOR_PORT_BIT.cassetteWrite,
    );

    expect(memory.datasette.motorActive).toBe(true);
    expect(tape.pulses.map(({ sourceCycles }) => sourceCycles)).toEqual([384]);
  });
});
