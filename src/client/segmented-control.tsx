import { useId, type CSSProperties } from 'react';
import './segmented-control.css';

type SegmentOption<Value extends string> = {
  value: Value;
  label: string;
  description?: string;
};

export function SegmentedControl<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  busy = false,
  className = '',
}: {
  label: string;
  value: Value;
  options: readonly SegmentOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const id = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  return (
    <div
      className={`ds-segmented-control ${className}`.trim()}
      style={
        {
          '--ds-segment-count': options.length || 1,
          '--ds-segment-index': selectedIndex,
        } as CSSProperties
      }
      role="radiogroup"
      aria-label={label}
      aria-busy={busy}
    >
      {selectedIndex >= 0 && <span className="ds-segmented-control-indicator" aria-hidden="true" />}
      {options.map((option) => (
        <label
          key={option.value}
          className="ds-segmented-control-option"
          title={option.description}
        >
          <input
            className="ds-segmented-control-input"
            type="radio"
            name={id}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            aria-disabled={busy || disabled}
            aria-label={
              option.description ? `${option.label} · ${option.description}` : option.label
            }
            // Keep keyboard focus while the parent saves, but prevent another change.
            onClick={(event) => {
              if (busy) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (
                busy &&
                [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
              )
                event.preventDefault();
            }}
            onChange={() => {
              if (!busy) onChange(option.value);
            }}
          />
          <span className="ds-segmented-control-label">{option.label}</span>
        </label>
      ))}
    </div>
  );
}
