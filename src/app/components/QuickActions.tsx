import { Download, FolderOpen, RotateCw, Upload } from 'lucide-react';
import { useRef, type ChangeEvent, type ReactNode } from 'react';

interface QuickActionsProps {
  readonly isReady: boolean;
  readonly onLoadFile: (file: File) => Promise<void>;
  readonly onReset: () => void;
}

interface QuickActionProps {
  readonly description: string;
  readonly disabled?: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick?: () => void;
}

function QuickAction({ description, disabled = false, icon, label, onClick }: QuickActionProps) {
  return (
    <button
      className="quick-action"
      type="button"
      disabled={disabled}
      title={disabled ? '状态序列化将在硬件状态模型完成后启用' : undefined}
      onClick={onClick}
    >
      <span className="quick-action__icon" aria-hidden="true">
        {icon}
      </span>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

export function QuickActions({ isReady, onLoadFile, onReset }: QuickActionsProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const chooseFile = (): void => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file) void onLoadFile(file);
    event.target.value = '';
  };

  return (
    <section className="quick-actions" aria-labelledby="quick-actions-title">
      <h2 id="quick-actions-title">快捷操作</h2>
      <input
        ref={fileInputRef}
        type="file"
        accept=".prg,application/octet-stream"
        hidden
        onChange={handleFileChange}
      />
      <div className="quick-actions__grid">
        <QuickAction
          description="加载 PRG 文件"
          disabled={!isReady}
          icon={<FolderOpen />}
          label="打开文件"
          onClick={chooseFile}
        />
        <QuickAction description="保存当前状态" disabled icon={<Download />} label="保存状态" />
        <QuickAction description="恢复保存状态" disabled icon={<Upload />} label="加载状态" />
        <QuickAction
          description="软重启 C64"
          disabled={!isReady}
          icon={<RotateCw />}
          label="重启系统"
          onClick={onReset}
        />
      </div>
    </section>
  );
}
