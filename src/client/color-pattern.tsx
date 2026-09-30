import { useState, type CSSProperties } from 'react';
import { Check, Palette, RotateCcw } from 'lucide-react';
import { colorPatterns, swatchForeground, type ColorAssignment } from '../shared/appearance';
import { useUi } from './ui-preferences';
import { ErrorNote, Modal } from './components';

export function usePatternColors() {
  const { preferences, resolvedTheme } = useUi();
  const pattern = colorPatterns.get(preferences.colorPattern);
  const resolve = (assignment: ColorAssignment) =>
    colorPatterns.resolve(pattern.id, resolvedTheme, assignment);
  return {
    pattern,
    resolve,
    style: (assignment: ColorAssignment) => resolve(assignment).tokens as CSSProperties,
  };
}

export function ColorPickerButton({
  label,
  value,
  colorKey,
  onChange,
  className = 'icon-button',
  text,
}: {
  label: string;
  value: number | null;
  colorKey: string;
  onChange: (value: number | null) => Promise<void>;
  className?: string;
  text?: string;
}) {
  const colors = usePatternColors();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function choose(slot: number | null) {
    setBusy(true);
    setError('');
    try {
      await onChange(slot);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`设置颜色 ${label}`}
        title="设置颜色"
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        <Palette size={14} aria-hidden="true" />
        {text && <span>{text}</span>}
      </button>
      {open && (
        <Modal title="选择颜色" close={() => !busy && setOpen(false)}>
          <p className="muted color-picker-description">
            {label} · {colors.pattern.name}
          </p>
          <div className="color-picker-grid" role="radiogroup" aria-label="组件颜色">
            {colors.pattern.colors.map((color, index) => (
              <button
                type="button"
                role="radio"
                key={color.id}
                aria-label={color.name}
                aria-checked={value !== null && value % colors.pattern.colors.length === index}
                disabled={busy}
                className="color-choice"
                onClick={() => void choose(index)}
              >
                <span
                  className="pattern-swatch"
                  style={{ background: color.color, color: swatchForeground(color.color) }}
                >
                  {value !== null && value % colors.pattern.colors.length === index && (
                    <Check size={18} />
                  )}
                </span>
                <span>{color.name}</span>
              </button>
            ))}
          </div>
          <div
            className="pattern-card color-picker-preview"
            style={colors.style({ key: colorKey, slot: value })}
          >
            <strong>{label}</strong>
            <p>颜色预览 · 文字始终清晰可读</p>
          </div>
          <ErrorNote text={error} />
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busy || value === null}
              onClick={() => void choose(null)}
            >
              <RotateCcw size={14} />
              恢复自动配色
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              完成
            </button>
          </div>
          <p className="small muted">
            {value === null ? '当前为自动配色。' : '当前颜色已保存。'}切换 Color Pattern
            后，会使用新色系中对应位置的颜色。
          </p>
        </Modal>
      )}
    </>
  );
}
