import { useId, useLayoutEffect, useRef, useState, useEffect, type CSSProperties } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ImagePlus,
  RotateCcw,
  X,
  Zap,
} from 'lucide-react';
import type { Model, ReasoningEffort } from '../../shared/types';

export const effortLevels: { value: ReasoningEffort; label: string; name: string }[] = [
  { value: 'none', label: '默认', name: 'None' },
  { value: 'low', label: '低', name: 'Low' },
  { value: 'medium', label: '中', name: 'Medium' },
  { value: 'high', label: '高', name: 'High' },
  { value: 'xhigh', label: '极高', name: 'Extra high' },
];

export function ModelPicker({
  models,
  modelId,
  effort,
  disabled,
  onModel,
  onEffort,
}: {
  models: Model[];
  modelId: string;
  effort: ReasoningEffort;
  disabled: boolean;
  onModel: (id: string) => void;
  onEffort: (effort: ReasoningEffort) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'models'>('effort');
  const [query, setQuery] = useState('');
  const selected = models.find((m) => m.id === modelId);
  const level = effortLevels.findIndex((item) => item.value === effort);
  const current = effortLevels[level];
  const filtered = models.filter((model) =>
    `${model.label} ${model.name} ${model.providerName}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  function close() {
    popup.current?.hidePopover();
    trigger.current?.focus();
  }
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
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const width = viewport?.width ?? innerWidth;
      const height = viewport?.height ?? innerHeight;
      const above = anchor.top - bounds.height - 8;
      panel.style.left = `${Math.max(left + 12, Math.min(anchor.right - bounds.width, left + width - bounds.width - 12))}px`;
      panel.style.top = `${Math.max(top + 12, Math.min(above >= top + 12 ? above : anchor.bottom + 8, top + height - bounds.height - 12))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    panel
      .querySelector<HTMLInputElement>(
        view === 'models' ? 'input[type="search"]' : 'input[type="range"]',
      )
      ?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [open, view]);
  return (
    <div className="model-picker">
      <button
        ref={trigger}
        type="button"
        className="model-picker-trigger"
        popoverTarget={id}
        disabled={disabled || !models.length}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`模型与思考程度：${selected?.label ?? '未配置模型'}，${current.label}`}
        title={
          selected
            ? `${selected.label} · ${selected.providerName} / ${current.name}`
            : '暂无可用模型'
        }
      >
        <span className="model-picker-name">{selected?.label ?? '选择模型'}</span>
        {selected && <span className="model-picker-effort">{current.label}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="dialog"
        aria-label="模型与思考设置"
        className="model-picker-popover"
        onToggle={(event) => {
          const visible = event.newState === 'open';
          setOpen(visible);
          if (!visible) {
            setView('effort');
            setQuery('');
          }
        }}
      >
        {view === 'effort' ? (
          <>
            <header className="effort-heading">
              <Zap size={18} aria-hidden="true" />
              <strong>思考程度 · {current.label}</strong>
              <button
                className="icon-button"
                aria-label="恢复默认思考程度"
                title="恢复默认"
                disabled={effort === 'none'}
                onClick={() => onEffort('none')}
              >
                <RotateCcw size={16} />
              </button>
              <button className="icon-button" aria-label="关闭模型设置" onClick={close}>
                <X size={16} />
              </button>
            </header>
            <button
              type="button"
              className="model-picker-current"
              aria-label="选择模型"
              onClick={() => setView('models')}
            >
              <span>
                <strong>{selected?.label}</strong>
                <small>{selected?.providerName}</small>
              </span>
              {selected?.vision && <ImagePlus size={16} aria-label="支持图片" />}
              <ChevronRight size={16} aria-hidden="true" />
            </button>
            <input
              className="effort-slider"
              style={{ '--effort-progress': `${level * 25}%` } as CSSProperties}
              type="range"
              min="0"
              max="4"
              step="1"
              value={level}
              aria-label="思考程度"
              aria-valuetext={`${current.name} · ${current.label}`}
              onChange={(event) => onEffort(effortLevels[Number(event.target.value)].value)}
            />
            <div className="effort-stops">
              {effortLevels.map((item) => (
                <button
                  type="button"
                  key={item.value}
                  aria-label={`思考程度 ${item.name}`}
                  aria-pressed={effort === item.value}
                  onClick={() => onEffort(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <header className="model-list-heading">
              <button
                className="icon-button"
                aria-label="返回思考设置"
                onClick={() => setView('effort')}
              >
                <ArrowLeft size={17} />
              </button>
              <strong>选择模型</strong>
              <button className="icon-button" aria-label="关闭模型设置" onClick={close}>
                <X size={16} />
              </button>
            </header>
            <input
              type="search"
              aria-label="搜索模型"
              placeholder="搜索模型或来源…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="model-picker-list" role="radiogroup" aria-label="可用模型">
              {filtered.map((model) => (
                <button
                  type="button"
                  role="radio"
                  key={model.id}
                  data-model-id={model.id}
                  aria-checked={model.id === modelId}
                  aria-label={`${model.label} · ${model.providerName}`}
                  onClick={() => {
                    onModel(model.id);
                    setView('effort');
                  }}
                >
                  <span>
                    <strong>
                      {model.label}{' '}
                      {model.id === models[0]?.id && <span className="badge">默认模型</span>}
                    </strong>
                    <small>{model.providerName}</small>
                  </span>
                  {model.vision && <ImagePlus size={15} aria-label="支持图片" />}
                  {model.id === modelId && <Check size={17} aria-hidden="true" />}
                </button>
              ))}
              {!filtered.length && <p className="muted">没有匹配的模型</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
