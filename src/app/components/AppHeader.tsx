import { Moon, Sun } from 'lucide-react';

import type { EmulatorPhase } from '../useC64Emulator';

interface AppHeaderProps {
  readonly darkTheme: boolean;
  readonly onToggleTheme: () => void;
  readonly phase: EmulatorPhase;
}

const PHASE_LABELS: Readonly<Record<EmulatorPhase, string>> = {
  error: '异常',
  loading: '启动中',
  paused: '已暂停',
  running: '运行中',
};

const NAVIGATION = [
  { href: '#console', label: '控制台' },
  { href: '#program-panel', label: '程序管理' },
  { href: '#keyboard-panel', label: '键位设置' },
  { href: '#runtime-panel', label: '系统设置' },
  { href: '#keyboard-panel', label: '帮助' },
] as const;

export function AppHeader({ darkTheme, onToggleTheme, phase }: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header__inner">
        <a className="app-title" href="#console" aria-label="返回运行控制台">
          运行控制台
        </a>

        <nav className="primary-navigation" aria-label="主导航">
          {NAVIGATION.map(({ href, label }, index) => (
            <a key={label} className={index === 0 ? 'is-active' : undefined} href={href}>
              {label}
            </a>
          ))}
        </nav>

        <div className="header-actions">
          <span className={`global-status global-status--${phase}`} aria-live="polite">
            <span aria-hidden="true" />
            {PHASE_LABELS[phase]}
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label={darkTheme ? '切换到浅色主题' : '切换到深色主题'}
            aria-pressed={darkTheme}
            onClick={onToggleTheme}
          >
            {darkTheme ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </button>
        </div>
      </div>
    </header>
  );
}
