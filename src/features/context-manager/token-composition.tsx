import { useId, useState } from 'react';
import { usePatternColors } from '../../client/color-pattern';
import { ErrorNote, Spinner } from '../../client/components';
import type { ContextSectionId, ContextSnapshot } from './types';
import { useTokenEstimate } from './use-token-estimate';
import './token-composition.css';

const sectionNames: Record<ContextSectionId, string> = {
  system: 'System prompt',
  'long-term': '长期记忆',
  session: 'Session 记忆',
  current: '当前 prompt',
};
const number = (value: number) => value.toLocaleString('zh-CN');

function percentage(tokens: number, total: number) {
  const share = total > 0 ? (tokens / total) * 100 : 0;
  if (share > 0 && share < 0.1) return '<0.1%';
  if (share > 99.9 && share < 100) return '>99.9%';
  return `${share.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
}

export function TokenComposition({ snapshot }: { snapshot: ContextSnapshot }) {
  const titleId = useId();
  const noteId = useId();
  const pattern = usePatternColors();
  const { data, error, retry } = useTokenEstimate(snapshot);
  const [selected, setSelected] = useState<ContextSectionId | null>(null);
  const [hovered, setHovered] = useState<ContextSectionId | null>(null);
  const [focused, setFocused] = useState<ContextSectionId | null>(null);
  const highlighted = hovered ?? focused ?? selected;
  let boundary = 0;
  const parts =
    data?.sections.map((estimate, index) => {
      const start = boundary;
      boundary += data.total > 0 ? (estimate.tokens / data.total) * 100 : 0;
      const section = snapshot.sections.find((section) => section.id === estimate.id);
      const empty =
        !section?.entries.length && (estimate.id === 'system' || estimate.id === 'long-term')
          ? '未注入'
          : !section?.entries.length && estimate.id === 'session'
            ? '暂无历史'
            : '无文本';
      return {
        ...estimate,
        start,
        end: boundary,
        name: sectionNames[estimate.id],
        share: percentage(estimate.tokens, data.total),
        color: pattern.resolve({ key: 'context-manager-sections', index }).color.color,
        empty,
      };
    }) ?? [];

  function cellBackground(index: number) {
    if (!data?.total) return undefined;
    const stops = parts.flatMap((part) => {
      const start = Math.max(index, part.start);
      const end = Math.min(index + 1, part.end);
      if (end <= start) return [];
      const color =
        highlighted && highlighted !== part.id
          ? `color-mix(in srgb, ${part.color} 18%, var(--cell))`
          : part.color;
      return [`${color} ${(start - index) * 100}% ${(end - index) * 100}%`];
    });
    return stops.length ? `linear-gradient(180deg, ${stops.join(', ')})` : undefined;
  }

  return (
    <section
      className="context-manager-token-composition"
      aria-labelledby={titleId}
      aria-busy={!data && !error}
    >
      <header className="context-manager-token-heading">
        <div>
          <div className="context-manager-token-title">
            <h4 id={titleId}>上下文 Token 占比</h4>
            <span className="context-manager-token-badge">估算</span>
          </div>
          <p className="context-manager-token-scope">
            {snapshot.requestCount === 0 ? '待发送上下文' : '最近一次回答模型请求的上下文'}
          </p>
        </div>
        {data && (
          <p className="context-manager-token-total">
            <strong>约 {number(data.total)}</strong>
            <span>文本 Token</span>
          </p>
        )}
      </header>

      {data ? (
        <>
          <div
            className="context-manager-token-grid"
            role="img"
            aria-label={`上下文文本 Token 估算：合计约 ${number(data.total)}。${parts
              .map((part) => `${part.name} 约 ${number(part.tokens)}，占 ${part.share}`)
              .join('；')}。`}
            aria-describedby={noteId}
          >
            {Array.from({ length: 100 }, (_, index) => (
              <span
                key={index}
                className="context-manager-token-cell"
                aria-hidden="true"
                style={{ background: cellBackground(index) }}
              />
            ))}
          </div>
          <p className="context-manager-token-scale">
            {data.total > 0 ? '每格约占 1%，颜色区分上下文组成。' : '当前上下文没有可统计的文本。'}
          </p>
          <div className="context-manager-token-legend" role="group" aria-label="高亮上下文分区">
            {parts.map((part) => (
              <button
                key={part.id}
                type="button"
                className="context-manager-token-part"
                data-highlighted={highlighted === part.id ? 'true' : undefined}
                aria-pressed={selected === part.id}
                aria-label={`${part.name}：约 ${number(part.tokens)} 文本 Token，占 ${part.share}${part.tokens === 0 ? `，${part.empty}` : ''}；点击高亮`}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') setHovered(part.id);
                }}
                onPointerLeave={() => setHovered(null)}
                onFocus={() => setFocused(part.id)}
                onBlur={() => setFocused(null)}
                onClick={() => setSelected((value) => (value === part.id ? null : part.id))}
              >
                <span
                  className="context-manager-token-swatch"
                  style={{ background: part.color }}
                  aria-hidden="true"
                />
                <span className="context-manager-token-part-label">
                  <span>{part.name}</span>
                  <span className="context-manager-token-part-value">
                    约 {number(part.tokens)} Token
                    {part.tokens === 0 && <> · {part.empty}</>}
                  </span>
                </span>
                <span className="context-manager-token-percent">{part.share}</span>
              </button>
            ))}
          </div>
        </>
      ) : error ? (
        <div className="context-manager-token-error">
          <ErrorNote text={error} />
          <button type="button" className="button" onClick={retry}>
            重新估算
          </button>
        </div>
      ) : (
        <div className="context-manager-token-loading">
          <Spinner />
          <p>正在估算文本 Token…</p>
        </div>
      )}

      <p id={noteId} className="context-manager-token-note">
        按本地分词估算，仅包含文本；图片和协议开销未计入。
        {snapshot.imageCount > 0 && ` 本次 ${number(snapshot.imageCount)} 张图片未计入占比。`}
      </p>
      <details className="context-manager-token-method">
        <summary>估算口径</summary>
        <p>
          使用 o200k_base 分词器分别统计各部分文本，用于比较上下文组成。不同模型的分词方式可能不同，
          包含快照中的工具定义与读取结果文本，不含图片、消息协议开销或隐藏推理，也不等同于供应商上报或计费用量。
        </p>
        <p>仅统计当前快照的输入文本，不包含本轮输出，也不累计本轮的多次模型请求。</p>
      </details>
    </section>
  );
}
