// +-------------------------------------------------------------------------
//
//   TypeScript Commodore 64 模拟器 - 移动端触控操纵杆
//
//   文件:       TouchControls.tsx
//
//   日期:       2026年08月09日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleDot } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { C64_CONTROL_PORT_DIGITAL_LINE } from '../../peripherals/control/C64ControlPorts';

type TouchControl = 'down' | 'fire' | 'left' | 'right' | 'up';

interface TouchControlsProps {
  readonly disabled: boolean;
  readonly onLinesChange: (sourceId: number, groundedDigitalLines: number) => void;
  readonly onRelease: (sourceId: number) => void;
}

const CONTROL_LINES: Readonly<Record<TouchControl, number>> = C64_CONTROL_PORT_DIGITAL_LINE;
const KEYBOARD_SOURCE_IDS: Readonly<Record<TouchControl, number>> = {
  down: -1,
  fire: -2,
  left: -3,
  right: -4,
  up: -5,
};
const DPAD_DEAD_ZONE = 0.18;

function dpadLinesAtPoint(element: HTMLElement, clientX: number, clientY: number): number {
  const bounds = element.getBoundingClientRect();
  const horizontal = (clientX - (bounds.left + bounds.width / 2)) / (bounds.width / 2);
  const vertical = (clientY - (bounds.top + bounds.height / 2)) / (bounds.height / 2);
  if (Math.hypot(horizontal, vertical) < DPAD_DEAD_ZONE) return 0;

  const octant = (Math.round(Math.atan2(vertical, horizontal) / (Math.PI / 4)) + 8) % 8;
  switch (octant) {
    case 0:
      return CONTROL_LINES.right;
    case 1:
      return CONTROL_LINES.down | CONTROL_LINES.right;
    case 2:
      return CONTROL_LINES.down;
    case 3:
      return CONTROL_LINES.down | CONTROL_LINES.left;
    case 4:
      return CONTROL_LINES.left;
    case 5:
      return CONTROL_LINES.up | CONTROL_LINES.left;
    case 6:
      return CONTROL_LINES.up;
    default:
      return CONTROL_LINES.up | CONTROL_LINES.right;
  }
}

interface JoystickButtonProps {
  readonly children: ReactNode;
  readonly className: string;
  readonly control: TouchControl;
  readonly disabled: boolean;
  readonly label: string;
  readonly onLinesChange: (sourceId: number, groundedDigitalLines: number) => void;
  readonly onRelease: (sourceId: number) => void;
  readonly pointerInput?: boolean;
  readonly pressed: boolean;
}

function JoystickButton({
  children,
  className,
  control,
  disabled,
  label,
  onLinesChange,
  onRelease,
  pointerInput = true,
  pressed,
}: JoystickButtonProps) {
  const sourceLines = CONTROL_LINES[control];

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!pointerInput || disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    onLinesChange(event.pointerId, sourceLines);
  };

  const handlePointerEnd = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!pointerInput) return;
    event.preventDefault();
    onRelease(event.pointerId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled || event.repeat || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    onLinesChange(KEYBOARD_SOURCE_IDS[control], sourceLines);
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    onRelease(KEYBOARD_SOURCE_IDS[control]);
  };

  return (
    <button
      className={className}
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-joystick-control={control}
      disabled={disabled}
      onBlur={() => onRelease(KEYBOARD_SOURCE_IDS[control])}
      onContextMenu={(event: MouseEvent<HTMLButtonElement>) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onLostPointerCapture={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
    >
      {children}
    </button>
  );
}

function TouchControlSession({ disabled, onLinesChange, onRelease }: TouchControlsProps) {
  const activeDpadPointers = useRef(new Set<number>());
  const activeSources = useRef(new Map<number, number>());
  const [pressedLines, setPressedLines] = useState(0);

  const synchronizePressedLines = useCallback((): void => {
    let nextLines = 0;
    for (const lines of activeSources.current.values()) nextLines |= lines;
    setPressedLines(nextLines);
  }, []);

  const releaseSource = useCallback(
    (sourceId: number): void => {
      if (!activeSources.current.delete(sourceId)) return;
      onRelease(sourceId);
      synchronizePressedLines();
    },
    [onRelease, synchronizePressedLines],
  );

  const setSourceLines = useCallback(
    (sourceId: number, lines: number): void => {
      if (lines === 0) {
        releaseSource(sourceId);
        return;
      }
      if (activeSources.current.get(sourceId) === lines) return;
      activeSources.current.set(sourceId, lines);
      onLinesChange(sourceId, lines);
      synchronizePressedLines();
    },
    [onLinesChange, releaseSource, synchronizePressedLines],
  );

  const releaseAllSources = useCallback((): void => {
    for (const sourceId of activeSources.current.keys()) onRelease(sourceId);
    activeDpadPointers.current.clear();
    activeSources.current.clear();
    synchronizePressedLines();
  }, [onRelease, synchronizePressedLines]);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') releaseAllSources();
    };
    window.addEventListener('blur', releaseAllSources);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', releaseAllSources);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [releaseAllSources]);

  useEffect(
    () => () => {
      for (const sourceId of activeSources.current.keys()) onRelease(sourceId);
      activeDpadPointers.current.clear();
      activeSources.current.clear();
    },
    [onRelease],
  );

  const handleDpadPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activeDpadPointers.current.add(event.pointerId);
    setSourceLines(
      event.pointerId,
      dpadLinesAtPoint(event.currentTarget, event.clientX, event.clientY),
    );
  };

  const handleDpadPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!activeDpadPointers.current.has(event.pointerId)) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      activeDpadPointers.current.delete(event.pointerId);
      releaseSource(event.pointerId);
      return;
    }
    setSourceLines(
      event.pointerId,
      dpadLinesAtPoint(event.currentTarget, event.clientX, event.clientY),
    );
  };

  const handleDpadPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    activeDpadPointers.current.delete(event.pointerId);
    releaseSource(event.pointerId);
  };

  const isPressed = (control: TouchControl): boolean =>
    (pressedLines & CONTROL_LINES[control]) !== 0;

  return (
    <section className="touch-controls" aria-label="触控操纵杆">
      <header className="touch-controls__header">
        <strong>TOUCH CONTROL</strong>
        <span>PORT 2 · 8-WAY</span>
      </header>
      <div
        className="touch-controls__dpad"
        role="group"
        aria-label="八方向控制"
        onLostPointerCapture={handleDpadPointerEnd}
        onPointerCancel={handleDpadPointerEnd}
        onPointerDown={handleDpadPointerDown}
        onPointerMove={handleDpadPointerMove}
        onPointerUp={handleDpadPointerEnd}
      >
        <JoystickButton
          className="joystick-button joystick-button--up"
          control="up"
          disabled={disabled}
          label="向上"
          onLinesChange={setSourceLines}
          onRelease={releaseSource}
          pointerInput={false}
          pressed={isPressed('up')}
        >
          <ArrowUp aria-hidden="true" />
        </JoystickButton>
        <JoystickButton
          className="joystick-button joystick-button--left"
          control="left"
          disabled={disabled}
          label="向左"
          onLinesChange={setSourceLines}
          onRelease={releaseSource}
          pointerInput={false}
          pressed={isPressed('left')}
        >
          <ArrowLeft aria-hidden="true" />
        </JoystickButton>
        <span className="touch-controls__dpad-center" aria-hidden="true" />
        <JoystickButton
          className="joystick-button joystick-button--right"
          control="right"
          disabled={disabled}
          label="向右"
          onLinesChange={setSourceLines}
          onRelease={releaseSource}
          pointerInput={false}
          pressed={isPressed('right')}
        >
          <ArrowRight aria-hidden="true" />
        </JoystickButton>
        <JoystickButton
          className="joystick-button joystick-button--down"
          control="down"
          disabled={disabled}
          label="向下"
          onLinesChange={setSourceLines}
          onRelease={releaseSource}
          pointerInput={false}
          pressed={isPressed('down')}
        >
          <ArrowDown aria-hidden="true" />
        </JoystickButton>
      </div>
      <div className="touch-controls__fire">
        <JoystickButton
          className="fire-button"
          control="fire"
          disabled={disabled}
          label="开火"
          onLinesChange={setSourceLines}
          onRelease={releaseSource}
          pressed={isPressed('fire')}
        >
          <CircleDot aria-hidden="true" />
          <span>FIRE</span>
        </JoystickButton>
        <small>八向滑动 · 可同时按住开火</small>
      </div>
    </section>
  );
}

export function TouchControls(props: TouchControlsProps) {
  return <TouchControlSession key={props.disabled ? 'disabled' : 'enabled'} {...props} />;
}
