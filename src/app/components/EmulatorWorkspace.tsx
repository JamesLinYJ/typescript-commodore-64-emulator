import type { CSSProperties, PointerEvent, RefObject } from 'react';

import type { EmulatorPhase, MessageTone } from '../useC64Emulator';

interface ScreenStyle extends CSSProperties {
  '--screen-scale': number;
}

interface EmulatorWorkspaceProps {
  readonly bootComplete: boolean;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly framesPerSecond: number | undefined;
  readonly message: string;
  readonly messageTone: MessageTone;
  readonly phase: EmulatorPhase;
  readonly programCounter: string;
  readonly screenFrameRef: RefObject<HTMLDivElement | null>;
  readonly zoom: number;
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
  framesPerSecond,
  message,
  messageTone,
  phase,
  programCounter,
  screenFrameRef,
  zoom,
}: EmulatorWorkspaceProps) {
  const screenStyle: ScreenStyle = { '--screen-scale': zoom };
  const bootMessage = phase === 'error' ? message : '正在读取 BASIC、KERNAL 与字符 ROM…';

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
          aria-busy={phase === 'loading'}
          onPointerDown={focusScreen}
        >
          <div className="screen-host" style={screenStyle}>
            <canvas ref={canvasRef} className="emulator-canvas">
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

      <div className={`emulator-feedback${messageTone === 'error' ? ' is-error' : ''}`}>
        <p aria-live="polite">{message}</p>
        <span aria-label="实时执行数据">
          {framesPerSecond ?? '—'} FPS · PC ${programCounter}
        </span>
      </div>
    </div>
  );
}
