import { useId } from 'react';
import type { ExtensionMode } from '../../shared/types';
const options = [
  { value: 'auto', label: 'Auto', description: '自动判断' },
  { value: 'on', label: 'On', description: '始终开启' },
  { value: 'off', label: 'Off', description: '始终关闭' },
] as const;
export function ExtensionModeControl({
  name,
  mode,
  disabled,
  saving = false,
  change,
}: {
  name: string;
  mode: ExtensionMode;
  disabled: boolean;
  saving?: boolean;
  change: (mode: ExtensionMode) => void;
}) {
  const id = useId();
  return (
    <div
      className="extensions-modes"
      role="radiogroup"
      aria-label={`${name} 默认模式`}
      aria-busy={saving}
    >
      {options.map((option) => (
        <label key={option.value} title={option.description}>
          <input
            type="radio"
            name={id}
            value={option.value}
            checked={mode === option.value}
            disabled={disabled}
            aria-disabled={saving || disabled}
            aria-label={`${option.label} · ${option.description}`}
            onClick={(event) => {
              if (saving) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (
                saving &&
                [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
              )
                event.preventDefault();
            }}
            onChange={() => {
              if (!saving) change(option.value);
            }}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
