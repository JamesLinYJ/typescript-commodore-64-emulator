import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { C64Emulator } from '../core/C64Emulator';
import type { BundledProgramDescriptor } from '../media/BundledProgramCatalog';
import { hex } from '../shared/numbers';
import { PAL_VIDEO_STANDARD } from '../video/palVideoStandard';

export type EmulatorPhase = 'error' | 'loading' | 'paused' | 'running';
export type MessageTone = 'error' | 'normal';

interface EmulatorViewState {
  readonly bootComplete: boolean;
  readonly framesPerSecond: number | undefined;
  readonly message: string;
  readonly messageTone: MessageTone;
  readonly overBudgetFrames: number;
  readonly phase: EmulatorPhase;
  readonly programCounter: string;
  readonly renderP95Ms: number | undefined;
  readonly sampledFrames: number;
}

export interface C64EmulatorController extends EmulatorViewState {
  readonly isReady: boolean;
  readonly loadBuiltInProgram: (program: BundledProgramDescriptor) => Promise<boolean>;
  readonly loadLocalProgram: (file: File) => Promise<boolean>;
  readonly releaseJoystickSource: (sourceId: number) => void;
  readonly reset: () => void;
  readonly stepFrame: () => void;
  readonly setJoystickSourceLines: (sourceId: number, groundedDigitalLines: number) => void;
  readonly toggle: () => void;
}

const INITIAL_MESSAGE = '模拟器初始化中。屏幕就绪后可选择内置程序，或载入本地 PRG。';
const READY_MESSAGE = 'BASIC 已就绪。选择程序后点击“载入”，或直接拖入 PRG 文件。';
const FRAME_SAMPLE_LIMIT = 120;
const PAL_FRAME_BUDGET_MS = 1000 / PAL_VIDEO_STANDARD.timing.refreshRateHz;

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function useC64Emulator(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  keyboardTargetRef: RefObject<HTMLElement | null>,
): C64EmulatorController {
  const emulatorRef = useRef<C64Emulator | null>(null);
  const bootCompleteRef = useRef(false);
  const programRequestRef = useRef<AbortController | null>(null);
  const operationIdRef = useRef(0);
  const [phase, setPhase] = useState<EmulatorPhase>('loading');
  const [framesPerSecond, setFramesPerSecond] = useState<number>();
  const [programCounter, setProgramCounter] = useState('0000');
  const [bootComplete, setBootComplete] = useState(false);
  const [message, setMessage] = useState(INITIAL_MESSAGE);
  const [messageTone, setMessageTone] = useState<MessageTone>('normal');
  const [renderP95Ms, setRenderP95Ms] = useState<number>();
  const [overBudgetFrames, setOverBudgetFrames] = useState(0);
  const [sampledFrames, setSampledFrames] = useState(0);

  const showMessage = useCallback((nextMessage: string): void => {
    setMessage(nextMessage);
    setMessageTone('normal');
  }, []);

  const showOperationError = useCallback((error: unknown): void => {
    setMessage(toError(error).message);
    setMessageTone('error');
  }, []);

  const showFatalError = useCallback((error: unknown): void => {
    setPhase('error');
    setMessage(toError(error).message);
    setMessageTone('error');
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const keyboardTarget = keyboardTargetRef.current;
    if (!canvas || !keyboardTarget) {
      showFatalError(new Error('模拟器界面未能正确挂载。'));
      return;
    }

    const initialization = new AbortController();
    let disposed = false;
    let emulator: C64Emulator | null = null;
    let framesSinceUpdate = 0;
    let lastFrameUpdate = performance.now();
    const renderTimes: number[] = [];
    bootCompleteRef.current = false;

    const initialize = async (): Promise<void> => {
      try {
        const { C64Emulator } = await import('../core/C64Emulator');
        const base = import.meta.env.BASE_URL;
        emulator = await C64Emulator.create({
          canvas,
          firmwareUrls: {
            basic: `${base}firmware/basic.901226-01.bin`,
            character: `${base}firmware/characters.901225-01.bin`,
            kernal: `${base}firmware/kernal.901227-03.bin`,
          },
          keyboardTarget,
          signal: initialization.signal,
        });

        if (disposed) {
          emulator.dispose();
          return;
        }

        emulatorRef.current = emulator;
        emulator.on('state', (nextState) => {
          if (nextState === 'running') {
            framesSinceUpdate = 0;
            lastFrameUpdate = performance.now();
            setFramesPerSecond(undefined);
          }
          setPhase(nextState);
        });
        emulator.on('frame', ({ renderTime }) => {
          renderTimes.push(renderTime);
          if (renderTimes.length > FRAME_SAMPLE_LIMIT) renderTimes.shift();

          if (emulator?.state === 'running') {
            framesSinceUpdate += 1;
            const now = performance.now();
            const elapsed = now - lastFrameUpdate;
            if (elapsed >= 500) {
              const sortedRenderTimes = [...renderTimes].sort((left, right) => left - right);
              const p95Index = Math.max(0, Math.ceil(sortedRenderTimes.length * 0.95) - 1);
              setFramesPerSecond(Math.round((framesSinceUpdate * 1000) / elapsed));
              setRenderP95Ms(sortedRenderTimes[p95Index]);
              setOverBudgetFrames(
                renderTimes.filter((renderTimeMs) => renderTimeMs > PAL_FRAME_BUDGET_MS).length,
              );
              setSampledFrames(renderTimes.length);
              setProgramCounter(hex(emulator.registers.programCounter, 4));
              framesSinceUpdate = 0;
              lastFrameUpdate = now;
            }
          } else {
            setProgramCounter(hex(emulator?.registers.programCounter ?? 0, 4));
          }

          if (!bootCompleteRef.current && emulator?.basicReady) {
            bootCompleteRef.current = true;
            setBootComplete(true);
            showMessage(READY_MESSAGE);
          }
        });
        emulator.on('programLoaded', ({ loadAddress, size }) => {
          showMessage(`已载入 ${size.toLocaleString('zh-CN')} 字节至 $${hex(loadAddress, 4)}。`);
        });
        emulator.on('error', showFatalError);

        emulator.start();
        showMessage('BASIC 正在启动。选择程序后点击“载入”，或直接拖入 PRG 文件。');
      } catch (error: unknown) {
        if (!initialization.signal.aborted) showFatalError(error);
      }
    };

    void initialize();

    return () => {
      disposed = true;
      initialization.abort();
      programRequestRef.current?.abort();
      operationIdRef.current += 1;
      if (emulatorRef.current === emulator) emulatorRef.current = null;
      emulator?.dispose();
    };
  }, [canvasRef, keyboardTargetRef, showFatalError, showMessage]);

  const loadBuiltInProgram = useCallback(
    async (program: BundledProgramDescriptor): Promise<boolean> => {
      const emulator = emulatorRef.current;
      if (!emulator) return false;

      programRequestRef.current?.abort();
      const request = new AbortController();
      programRequestRef.current = request;
      const operationId = ++operationIdRef.current;
      showMessage(`正在载入 ${program.title}…`);

      try {
        await emulator.loadProgram(`${import.meta.env.BASE_URL}programs/${program.file}`, {
          signal: request.signal,
        });
        return operationIdRef.current === operationId;
      } catch (error: unknown) {
        if (!isAbortError(error)) showOperationError(error);
        return false;
      } finally {
        if (programRequestRef.current === request) programRequestRef.current = null;
      }
    },
    [showMessage, showOperationError],
  );

  const loadLocalProgram = useCallback(
    async (file: File): Promise<boolean> => {
      const emulator = emulatorRef.current;
      if (!emulator) return false;
      if (!file.name.toLowerCase().endsWith('.prg')) {
        showOperationError(new Error('请选择扩展名为 .prg 的 Commodore 64 程序。'));
        return false;
      }

      programRequestRef.current?.abort();
      const request = new AbortController();
      programRequestRef.current = request;
      const operationId = ++operationIdRef.current;
      showMessage(`正在读取 ${file.name}…`);

      try {
        const bytes = await file.arrayBuffer();
        if (
          request.signal.aborted ||
          operationIdRef.current !== operationId ||
          emulatorRef.current !== emulator
        ) {
          return false;
        }
        await emulator.loadProgramBytesAsync(bytes, {}, request.signal);
        return true;
      } catch (error: unknown) {
        if (!isAbortError(error)) showOperationError(error);
        return false;
      } finally {
        if (programRequestRef.current === request) programRequestRef.current = null;
      }
    },
    [showMessage, showOperationError],
  );

  const toggle = useCallback((): void => {
    emulatorRef.current?.toggle();
  }, []);

  const setJoystickSourceLines = useCallback(
    (sourceId: number, groundedDigitalLines: number): void => {
      emulatorRef.current?.input.setJoystickSourceLines(sourceId, groundedDigitalLines);
    },
    [],
  );

  const releaseJoystickSource = useCallback((sourceId: number): void => {
    emulatorRef.current?.input.releaseJoystickSource(sourceId);
  }, []);

  const reset = useCallback((): void => {
    const emulator = emulatorRef.current;
    if (!emulator) return;
    bootCompleteRef.current = false;
    setBootComplete(false);
    emulator.reset();
    setProgramCounter(hex(emulator.registers.programCounter, 4));
    showMessage('CPU 已复位，内存内容保持不变。');
  }, [showMessage]);

  const stepFrame = useCallback((): void => {
    const emulator = emulatorRef.current;
    if (!emulator || emulator.state === 'running') return;
    emulator.stepFrame();
    setProgramCounter(hex(emulator.registers.programCounter, 4));
    showMessage('已执行一帧。');
  }, [showMessage]);

  const isReady = bootComplete && (phase === 'paused' || phase === 'running');

  return {
    bootComplete,
    framesPerSecond,
    isReady,
    loadBuiltInProgram,
    loadLocalProgram,
    message,
    messageTone,
    overBudgetFrames,
    phase,
    programCounter,
    releaseJoystickSource,
    renderP95Ms,
    reset,
    sampledFrames,
    stepFrame,
    setJoystickSourceLines,
    toggle,
  };
}
