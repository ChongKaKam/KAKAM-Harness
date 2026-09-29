import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Globe, Puzzle, X } from 'lucide-react';
import { ErrorNote } from '../../client/components';
import { ExtensionModeControl } from './mode-control';
import { useExtensions } from './use-extensions';
export { useExtensions } from './use-extensions';
import './extensions.css';

export function ExtensionControls({
  controls,
  disabled,
}: {
  controls: ReturnType<typeof useExtensions>;
  disabled: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const active = Object.values(controls.modes).filter((mode) => mode !== 'off').length;
  const close = () => {
    popup.current?.hidePopover();
    trigger.current?.focus();
  };
  useEffect(() => {
    if (disabled) popup.current?.hidePopover();
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = popup.current!;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0,
        left = viewport?.offsetLeft ?? 0;
      const width = viewport?.width ?? innerWidth,
        height = viewport?.height ?? innerHeight;
      const above = anchor.top - bounds.height - 8;
      panel.style.left = `${Math.max(left + 12, Math.min(anchor.left, left + width - bounds.width - 12))}px`;
      panel.style.top = `${Math.max(top + 12, Math.min(above >= top + 12 ? above : anchor.bottom + 8, top + height - bounds.height - 12))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    panel
      .querySelector<HTMLInputElement>('input:checked:not(:disabled)')
      ?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open]);
  return (
    <div className="extensions-controls" role="group" aria-label="拓展能力">
      <button
        ref={trigger}
        type="button"
        className={`extensions-trigger ${active ? 'active' : ''}`}
        popoverTarget={id}
        disabled={disabled || controls.loading}
        aria-label="拓展能力"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        title={active ? `拓展能力 · ${active} 项开启或自动` : '拓展能力 · 全部关闭'}
      >
        <Puzzle size={18} aria-hidden="true" />
        {active > 0 && (
          <span className="extensions-count" aria-hidden="true">
            {active}
          </span>
        )}
      </button>
      <div
        id={id}
        ref={popup}
        popover="auto"
        role="dialog"
        aria-label="聊天拓展能力"
        className="extensions-popover"
        style={{ visibility: open ? 'visible' : 'hidden' }}
        onToggle={(event) => setOpen(event.newState === 'open')}
      >
        <header className="extensions-popover-heading">
          <Puzzle size={18} />
          <strong>拓展能力</strong>
          <button className="icon-button" aria-label="关闭拓展能力" onClick={close}>
            <X size={16} />
          </button>
        </header>
        <p className="small muted">Auto 自动判断 · On 开启 · Off 关闭</p>
        <ErrorNote text={controls.error} />
        {controls.capabilities.map((item) => {
          const Icon = item.icon === 'globe' ? Globe : Puzzle;
          return (
            <section key={item.id} className="extensions-menu-item" aria-label={item.name}>
              <div className="extensions-menu-name">
                <Icon size={18} />
                <strong>{item.name}</strong>
                {(!item.ready || !item.enabled) && (
                  <span className="badge">{item.enabled ? '待配置' : '已关闭'}</span>
                )}
              </div>
              <p className="small muted">{item.description}</p>
              <ExtensionModeControl
                name={item.name}
                mode={controls.preferences[item.id] ?? 'off'}
                disabled={disabled || !item.ready || !item.enabled}
                saving={controls.saving}
                change={(mode) => void controls.change(item.id, mode)}
              />
            </section>
          );
        })}
        {!controls.capabilities.length && (
          <p className="muted">暂无可用拓展，请在设置中启用插件。</p>
        )}
      </div>
    </div>
  );
}
