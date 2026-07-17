import { ChevronRight, Pause, Play, RotateCcw, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import { BUNDLED_PROGRAMS, type BundledProgramDescriptor } from '../../media/BundledProgramCatalog';
import type { EmulatorPhase } from '../useC64Emulator';

interface ControlPanelProps {
  readonly isReady: boolean;
  readonly onLoadFile: (file: File) => Promise<void>;
  readonly onLoadProgram: (program: BundledProgramDescriptor) => Promise<void>;
  readonly onPause: () => void;
  readonly onReset: () => void;
  readonly onRun: () => void;
  readonly onZoomChange: (zoom: number) => void;
  readonly phase: EmulatorPhase;
  readonly zoom: number;
}

export function ControlPanel({
  isReady,
  onLoadFile,
  onLoadProgram,
  onPause,
  onReset,
  onRun,
  onZoomChange,
  phase,
  zoom,
}: ControlPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState('galaga.prg');
  const [isDragging, setIsDragging] = useState(false);
  const [showAllKeys, setShowAllKeys] = useState(false);
  const running = phase === 'running';

  const handleProgramChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setSelectedFile(event.target.value);
  };

  const handleLoadProgram = (): void => {
    const selectedProgram = BUNDLED_PROGRAMS.find(({ file }) => file === selectedFile);
    if (selectedProgram) void onLoadProgram(selectedProgram);
  };

  const handleChooseFile = (): void => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file) void onLoadFile(file);
    event.target.value = '';
  };

  const handleDragOver = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (): void => {
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void onLoadFile(file);
  };

  const handleZoomChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onZoomChange(Number(event.target.value));
  };

  return (
    <aside className="control-panel" aria-label="模拟器控制面板">
      <section id="program-panel" className="panel-card">
        <h2>程序</h2>
        <label className="field-label" htmlFor="program-select">
          选择 PRG 文件
        </label>
        <div className="select-row">
          <select
            id="program-select"
            value={selectedFile}
            disabled={!isReady}
            onChange={handleProgramChange}
          >
            {BUNDLED_PROGRAMS.map(({ file, title, year }) => (
              <option key={file} value={file}>
                {title} - {year}.prg
              </option>
            ))}
          </select>
          <button
            className="button button--outline-primary"
            type="button"
            disabled={!isReady}
            onClick={handleLoadProgram}
          >
            载入程序
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".prg,application/octet-stream"
          hidden
          onChange={handleFileChange}
        />
        <button
          className={`drop-target${isDragging ? ' is-dragging' : ''}`}
          type="button"
          disabled={!isReady}
          onClick={handleChooseFile}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <Upload aria-hidden="true" />
          <span>拖放 PRG 文件到此处</span>
          <small>或点击浏览选择文件</small>
        </button>
      </section>

      <section id="runtime-panel" className="panel-card">
        <h2>运行控制</h2>
        <div className="transport" role="group" aria-label="运行控制">
          <button
            className={`button button--transport button--run${running ? ' is-active' : ''}`}
            type="button"
            disabled={!isReady || running}
            onClick={onRun}
          >
            <Play aria-hidden="true" />
            运行
          </button>
          <button
            className="button button--transport"
            type="button"
            disabled={!isReady || !running}
            onClick={onPause}
          >
            <Pause aria-hidden="true" />
            暂停
          </button>
          <button
            className="button button--transport"
            type="button"
            disabled={!isReady}
            onClick={onReset}
          >
            <RotateCcw aria-hidden="true" />
            重置
          </button>
        </div>
        <label className="zoom-control">
          <span>
            显示缩放 <output>{zoom.toFixed(1)}×</output>
          </span>
          <input type="range" min="1" max="2" value={zoom} step="0.1" onChange={handleZoomChange} />
        </label>
      </section>

      <section id="keyboard-panel" className="panel-card panel-card--keys">
        <h2>快捷键参考</h2>
        <dl className="key-list">
          <div>
            <dt>方向键</dt>
            <dd>移动光标</dd>
          </div>
          <div>
            <dt>Space / 数字键盘 0</dt>
            <dd>开火 / 选择</dd>
          </div>
          <div>
            <dt>RESTORE</dt>
            <dd>Page Up</dd>
          </div>
          <div>
            <dt>F1 ~ F8</dt>
            <dd>功能键</dd>
          </div>
          <div>
            <dt>C=</dt>
            <dd>Alt</dd>
          </div>
          {showAllKeys ? (
            <>
              <div>
                <dt>RUN/STOP</dt>
                <dd>Escape</dd>
              </div>
              <div>
                <dt>DELETE</dt>
                <dd>Backspace</dd>
              </div>
              <div>
                <dt>RETURN</dt>
                <dd>Enter</dd>
              </div>
              <div>
                <dt>SHIFT LOCK</dt>
                <dd>Caps Lock</dd>
              </div>
            </>
          ) : null}
        </dl>
        <button
          className="key-list-toggle"
          type="button"
          aria-expanded={showAllKeys}
          onClick={() => setShowAllKeys((current) => !current)}
        >
          {showAllKeys ? '收起完整键位表' : '查看完整键位表'}
          <ChevronRight aria-hidden="true" />
        </button>
      </section>
    </aside>
  );
}
