import { useCallback, useRef, useState } from 'react';

import { AppHeader } from './components/AppHeader';
import { ControlPanel } from './components/ControlPanel';
import { EmulatorWorkspace } from './components/EmulatorWorkspace';
import { QuickActions } from './components/QuickActions';
import type { BundledProgramDescriptor } from '../media/BundledProgramCatalog';
import { useC64Emulator } from './useC64Emulator';

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenFrameRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1.4);
  const [darkTheme, setDarkTheme] = useState(false);
  const emulator = useC64Emulator(canvasRef, screenFrameRef);
  const { loadBuiltInProgram, loadLocalProgram, reset, toggle } = emulator;

  const focusScreen = useCallback((): void => {
    screenFrameRef.current?.focus();
  }, []);

  const handleLoadProgram = useCallback(
    async (program: BundledProgramDescriptor): Promise<void> => {
      if (await loadBuiltInProgram(program)) focusScreen();
    },
    [focusScreen, loadBuiltInProgram],
  );

  const handleLoadFile = useCallback(
    async (file: File): Promise<void> => {
      if (await loadLocalProgram(file)) focusScreen();
    },
    [focusScreen, loadLocalProgram],
  );

  const handleRun = useCallback((): void => {
    if (emulator.phase === 'paused') toggle();
  }, [emulator.phase, toggle]);

  const handlePause = useCallback((): void => {
    if (emulator.phase === 'running') toggle();
  }, [emulator.phase, toggle]);

  const toggleTheme = useCallback((): void => {
    setDarkTheme((current) => !current);
  }, []);

  return (
    <div className={`app-page${darkTheme ? ' app-page--dark' : ''}`}>
      <AppHeader phase={emulator.phase} darkTheme={darkTheme} onToggleTheme={toggleTheme} />

      <main className="dashboard" aria-label="TypeScript Commodore 64 Emulator 运行控制台">
        <section id="console" className="console-card" aria-label="Commodore 64 主机">
          <EmulatorWorkspace
            bootComplete={emulator.bootComplete}
            canvasRef={canvasRef}
            framesPerSecond={emulator.framesPerSecond}
            message={emulator.message}
            messageTone={emulator.messageTone}
            phase={emulator.phase}
            programCounter={emulator.programCounter}
            screenFrameRef={screenFrameRef}
            zoom={zoom}
          />
          <QuickActions isReady={emulator.isReady} onLoadFile={handleLoadFile} onReset={reset} />
        </section>

        <ControlPanel
          isReady={emulator.isReady}
          onLoadFile={handleLoadFile}
          onLoadProgram={handleLoadProgram}
          onPause={handlePause}
          onReset={reset}
          onRun={handleRun}
          onZoomChange={setZoom}
          phase={emulator.phase}
          zoom={zoom}
        />
      </main>
    </div>
  );
}
