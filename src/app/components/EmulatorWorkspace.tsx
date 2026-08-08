import { useState, type CSSProperties, type PointerEvent, type RefObject } from 'react';

import type { EmulatorPhase, MessageTone } from '../useC64Emulator';
import { PAL_VIDEO_STANDARD } from '../../video/palVideoStandard';

interface ScreenStyle extends CSSProperties {
  '--screen-width': string;
}

export type DisplayScale = 'fit' | '1x' | '2x';

interface EmulatorWorkspaceProps {
  readonly bootComplete: boolean;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly displayScale: DisplayScale;
  readonly framesPerSecond: number | undefined;
  readonly message: string;
  readonly messageTone: MessageTone;
  readonly overBudgetFrames: number;
  readonly phase: EmulatorPhase;
  readonly programCounter: string;
  readonly renderP95Ms: number | undefined;
  readonly sampledFrames: number;
  readonly screenFrameRef: RefObject<HTMLDivElement | null>;
}

const PHASE_LABELS: Readonly<Record<EmulatorPhase, string>> = {
  error: '异常',
  loading: '初始化',
  paused: '已暂停',
  running: '就绪',
};

function focusScreen(event: PointerEvent<HTMLDivElement>): void {
  event.currentTarget.focus();
}

export function EmulatorWorkspace({
  bootComplete,
  canvasRef,
  displayScale,
  framesPerSecond,
  message,
  messageTone,
  overBudgetFrames,
  phase,
  programCounter,
  renderP95Ms,
  sampledFrames,
  screenFrameRef,
}: EmulatorWorkspaceProps) {
  const [screenFocused, setScreenFocused] = useState(false);
  const scale = displayScale === '2x' ? 2 : 1;
  const screenStyle: ScreenStyle = {
    '--screen-width': `${PAL_VIDEO_STANDARD.output.width * scale}px`,
  };
  const bootMessage = phase === 'error' ? message : '正在读取 BASIC、KERNAL 与字符 ROM…';
  const performanceText =
    renderP95Ms === undefined
      ? '正在采样帧耗时'
      : `p95 ${renderP95Ms.toFixed(2)} ms / ${(1000 / PAL_VIDEO_STANDARD.timing.refreshRateHz).toFixed(2)} ms 预算`;

  return (
    <div className="emulator-workspace">
      <header className="console-overview">
        <div className="machine-identity">
          <h1>Commodore 64</h1>
          <span className={`machine-status machine-status--${phase}`}>
            <span aria-hidden="true" />
            {PHASE_LABELS[phase]}
          </span>
        </div>

        <dl className="machine-facts" aria-label="主机规格">
          <div>
            <dt>模式</dt>
            <dd>PAL</dd>
          </div>
          <div>
            <dt>内存</dt>
            <dd>64 KB</dd>
          </div>
          <div>
            <dt>C64 RAM</dt>
            <dd>38911 字节可用</dd>
          </div>
        </dl>
      </header>

      <div className="display-area">
        <div
          ref={screenFrameRef}
          className="screen-frame"
          tabIndex={0}
          aria-label="C64 屏幕，聚焦后可使用键盘"
          aria-describedby="c64-screen-help"
          aria-busy={phase === 'loading'}
          onBlur={() => setScreenFocused(false)}
          onFocus={() => setScreenFocused(true)}
          onPointerDown={focusScreen}
        >
          <div
            className={`screen-host screen-host--${displayScale === 'fit' ? 'fit' : 'fixed'}`}
            style={screenStyle}
          >
            <div className="screen-stack">
              <canvas
                ref={canvasRef}
                className="emulator-canvas"
                aria-label="Commodore 64 视频输出"
              >
                当前浏览器不支持 Canvas，无法显示 C64 画面。
              </canvas>
              <div
                className={`boot-overlay${bootComplete ? ' is-complete' : ''}`}
                aria-hidden={bootComplete}
              >
                <span className="boot-overlay__scan" aria-hidden="true" />
                <p>{bootMessage}</p>
              </div>
            </div>
          </div>
        </div>
        <p id="c64-screen-help" className={`screen-focus-hint${screenFocused ? ' is-active' : ''}`}>
          {screenFocused ? '键盘已接管 · 点击页面其他位置可释放焦点' : '点击屏幕以启用 C64 键盘'}
        </p>
      </div>

      <div className={`emulator-feedback${messageTone === 'error' ? ' is-error' : ''}`}>
        <p aria-live="polite">{message}</p>
        <div className="runtime-telemetry" aria-label="实时执行数据">
          <span>
            PAL {PAL_VIDEO_STANDARD.timing.refreshRateHz.toFixed(2)} Hz · 呈现{' '}
            {framesPerSecond ?? '—'} FPS · {performanceText}
            {sampledFrames > 0 ? ` · 超预算 ${overBudgetFrames}/${sampledFrames}` : ''}
          </span>
          <details>
            <summary>诊断</summary>
            <span>PC ${programCounter}</span>
          </details>
        </div>
      </div>
    </div>
  );
}
