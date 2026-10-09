import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  BookOpen,
  FileOutput,
  ImagePlus,
  Plus,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { ExtensionOptions, type useExtensions } from '../extensions/chat-controls';
import { ProductionModeControl } from '../llm-production/composer-control';
import type { ProductionMode } from '../llm-production/types';
import { SkillPicker, type useChatSkills } from '../skills/chat-controls';

export function ComposerActions({
  disabled,
  vision,
  toolCalling,
  addImages,
  skills,
  skillsEnabled,
  productionEnabled,
  productionMode,
  onProductionMode,
  formatting,
  onFormatting,
  extensions,
}: {
  disabled: boolean;
  vision: boolean;
  toolCalling: boolean;
  addImages(): void;
  skills: ReturnType<typeof useChatSkills>;
  skillsEnabled: boolean;
  productionEnabled: boolean;
  productionMode: ProductionMode;
  onProductionMode(mode: ProductionMode): void;
  formatting: boolean;
  onFormatting(value: boolean): void;
  extensions: ReturnType<typeof useExtensions>;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const active = extensions.capabilities.filter((item) => extensions.modes[item.id] === 'on');
  const required = productionEnabled && productionMode === 'required';
  const summary = [
    ...(required ? ['必须产物'] : []),
    ...(active.length > 1 ? [`${active.length} 项拓展`] : active.map((item) => item.name)),
  ].join(' · ');
  const close = () => {
    popup.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (disabled) popup.current?.hidePopover();
  }, [disabled]);
  useEffect(() => {
    if (!skillsEnabled) setPicker(false);
  }, [skillsEnabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = popup.current!;
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth;
      const height = viewport?.height ?? innerHeight;
      panel.style.maxWidth = `${Math.max(0, width - 24)}px`;
      panel.style.maxHeight = `${Math.max(0, height - 24)}px`;
      const bounds = panel.getBoundingClientRect();
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
      .querySelector<HTMLElement>(
        'button.chat-composer-menu-item:not(:disabled), input:not(:disabled), select:not(:disabled)',
      )
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
    <div className="chat-composer-actions">
      <button
        ref={trigger}
        type="button"
        className="chat-composer-menu-trigger"
        aria-label="添加内容和工具"
        title="添加内容和工具"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        disabled={disabled}
      >
        <Plus size={22} aria-hidden="true" />
      </button>
      {summary && (
        <button
          type="button"
          className="chat-composer-chip"
          title={summary}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={id}
          popoverTarget={id}
          disabled={disabled}
        >
          {required ? (
            <FileOutput size={14} aria-hidden="true" />
          ) : (
            <Sparkles size={14} aria-hidden="true" />
          )}
          <span>{summary}</span>
        </button>
      )}
      <div
        id={id}
        ref={popup}
        popover="auto"
        role="dialog"
        aria-label="添加内容和工具"
        className="chat-composer-menu"
        style={{ visibility: open ? 'visible' : 'hidden' }}
        onToggle={(event) => setOpen(event.newState === 'open')}
      >
        <header className="chat-composer-menu-heading">
          <strong>添加内容和工具</strong>
          <button type="button" className="icon-button" aria-label="关闭添加菜单" onClick={close}>
            <X size={16} />
          </button>
        </header>
        <section className="chat-composer-menu-section">
          <button
            type="button"
            className="chat-composer-menu-item"
            aria-label="添加图片"
            disabled={disabled || !vision}
            onClick={() => {
              popup.current?.hidePopover();
              addImages();
            }}
          >
            <ImagePlus size={18} aria-hidden="true" />
            <span className="chat-composer-menu-item-copy">
              <span className="chat-composer-menu-item-title">添加图片</span>
              {!vision && (
                <span className="chat-composer-menu-item-description">当前模型不支持图片</span>
              )}
            </span>
          </button>
          <button
            type="button"
            className="chat-composer-menu-item"
            disabled={disabled || !skillsEnabled || skills.loading}
            onClick={() => {
              popup.current?.hidePopover();
              setPicker(true);
            }}
          >
            <BookOpen size={18} aria-hidden="true" />
            <span className="chat-composer-menu-item-copy">
              <span className="chat-composer-menu-item-title">Skill 库</span>
              {!skillsEnabled && (
                <span className="chat-composer-menu-item-description">插件已停用</span>
              )}
            </span>
            <span className="badge">插件</span>
          </button>
          <label className="chat-composer-menu-item">
            <SlidersHorizontal size={18} aria-hidden="true" />
            <span className="chat-composer-menu-item-copy">显示文本格式</span>
            <input
              type="checkbox"
              checked={formatting}
              disabled={disabled}
              onChange={(event) => onFormatting(event.target.checked)}
            />
          </label>
        </section>
        {productionEnabled && (
          <section className="chat-composer-menu-section">
            <ProductionModeControl
              mode={productionMode}
              onChange={onProductionMode}
              disabled={disabled}
              toolCalling={toolCalling}
            />
          </section>
        )}
        <section className="chat-composer-menu-section">
          <h3>拓展能力</h3>
          <ExtensionOptions controls={extensions} disabled={disabled} />
        </section>
      </div>
      {picker && (
        <SkillPicker
          selected={skills.selected}
          change={skills.setSelected}
          close={() => {
            setPicker(false);
            requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
          }}
        />
      )}
    </div>
  );
}
