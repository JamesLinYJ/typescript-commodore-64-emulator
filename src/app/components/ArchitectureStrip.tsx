export function ArchitectureStrip() {
  return (
    <footer className="architecture-strip">
      <p>
        <strong>TypeScript core</strong>
        <span>React 界面 · 无全局命名空间 · 严格类型检查</span>
      </p>
      <ol aria-label="运行架构">
        <li>Cpu6502</li>
        <li>C64Machine</li>
        <li>VIC-II / CIA / SID</li>
        <li>Realtime loop</li>
        <li>Canvas / Audio sinks</li>
      </ol>
    </footer>
  );
}
