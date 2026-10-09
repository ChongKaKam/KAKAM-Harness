import { useId } from 'react';
import type { ProductionMode } from './types';
import './production.css';

export function ProductionModeControl({
  mode,
  onChange,
  disabled,
  toolCalling,
}: {
  mode: ProductionMode;
  onChange: (mode: ProductionMode) => void;
  disabled: boolean;
  toolCalling: boolean;
}) {
  const id = useId();
  return (
    <div className="llm-production-composer-control">
      <label htmlFor={id}>产物输出</label>
      <select
        id={id}
        aria-describedby={`${id}-description`}
        value={mode}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as ProductionMode)}
      >
        <option value="auto">自动</option>
        <option value="required" disabled={!toolCalling}>
          必须产物
        </option>
      </select>
      <span id={`${id}-description`} className="llm-production-composer-description">
        {!toolCalling
          ? '当前模型未启用工具调用，请切换模型后生成产物。'
          : mode === 'required'
            ? '本轮须交付文件或图片；需求不足时先澄清。'
            : '由聊天模型判断是否生成文件或图片。'}
      </span>
    </div>
  );
}
