import { useId, useState } from 'react';
import { usePatternColors } from '../../client/color-pattern';
import type { ContextSectionId, ContextSnapshot } from './types';
import { characterGrid } from './character-grid';
import './character-composition.css';

const sectionNames: Record<ContextSectionId, string> = {
  system: 'System prompt',
  'long-term': '长期记忆',
  group: '分组记忆',
  session: 'Session 记忆',
  current: '当前 prompt',
};
const number = (value: number) => value.toLocaleString('zh-CN');

function percentage(characters: number, total: number) {
  const share = total > 0 ? (characters / total) * 100 : 0;
  if (share > 0 && share < 0.1) return '<0.1%';
  if (share > 99.9 && share < 100) return '>99.9%';
  return `${share.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
}

export function CharacterComposition({ snapshot }: { snapshot: ContextSnapshot }) {
  const titleId = useId();
  const noteId = useId();
  const pattern = usePatternColors();
  const grid = characterGrid(snapshot.sections);
  const total = snapshot.sections.reduce((sum, section) => sum + section.characters, 0);
  const [selected, setSelected] = useState<ContextSectionId | null>(null);
  const [hovered, setHovered] = useState<ContextSectionId | null>(null);
  const [focused, setFocused] = useState<ContextSectionId | null>(null);
  const highlighted = hovered ?? focused ?? selected;
  const parts = snapshot.sections.map((section, index) => {
    const empty =
      !section.entries.length &&
      (section.id === 'system' || section.id === 'long-term' || section.id === 'group')
        ? '未注入'
        : !section.entries.length && section.id === 'session'
          ? '暂无历史'
          : '无文本';
    return {
      id: section.id,
      characters: section.characters,
      name: sectionNames[section.id],
      share: percentage(section.characters, total),
      color: pattern.resolve({ key: 'context-manager-sections', index }).color.color,
      empty,
    };
  });

  return (
    <section className="context-manager-character-composition" aria-labelledby={titleId}>
      <header className="context-manager-character-heading">
        <div>
          <h4 id={titleId}>上下文字符分布</h4>
          <p className="context-manager-character-scope">
            {snapshot.requestCount === 0 ? '待发送上下文' : '最近一次回答模型请求的上下文'}
          </p>
        </div>
        <p className="context-manager-character-total">
          <strong>{number(total)}</strong>
          <span>字符</span>
        </p>
      </header>

      <div
        className="context-manager-character-grid"
        role="img"
        aria-label={`上下文字符组成：合计 ${number(total)} 字符，每格最多 ${number(grid.charactersPerCell)} 字符。${parts
          .map((part) => `${part.name} ${number(part.characters)} 字符，占 ${part.share}`)
          .join('；')}。`}
        aria-describedby={noteId}
      >
        {grid.cells.map((sectionId, index) => (
          <span
            key={index}
            className="context-manager-character-cell"
            aria-hidden="true"
            data-section={sectionId ?? undefined}
            data-dimmed={sectionId && highlighted && highlighted !== sectionId ? 'true' : undefined}
            style={{ background: parts.find((part) => part.id === sectionId)?.color }}
          />
        ))}
      </div>
      <div className="context-manager-character-legend" role="group" aria-label="高亮上下文分区">
        {parts.map((part) => (
          <button
            key={part.id}
            type="button"
            className="context-manager-character-part"
            data-highlighted={highlighted === part.id ? 'true' : undefined}
            aria-pressed={selected === part.id}
            aria-label={`${part.name}：${number(part.characters)} 字符，占 ${part.share}${part.characters === 0 ? `，${part.empty}` : ''}；点击高亮`}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') setHovered(part.id);
            }}
            onPointerLeave={() => setHovered(null)}
            onFocus={() => setFocused(part.id)}
            onBlur={() => setFocused(null)}
            onClick={() => setSelected((value) => (value === part.id ? null : part.id))}
          >
            <span
              className="context-manager-character-swatch"
              style={{ background: part.color }}
              aria-hidden="true"
            />
            <span>{part.name}</span>
            <span className="context-manager-character-part-value">{number(part.characters)}</span>
          </button>
        ))}
      </div>

      <p id={noteId} className="context-manager-character-note">
        每格 ≤ {number(grid.charactersPerCell)} 字符 · 各部分末格不足时按一格显示 · 灰格为展示留白
      </p>
      <p className="context-manager-character-note">
        {total === 0 ? '当前上下文没有可统计的文本。' : '统计包含空格与换行，图片不计入。'}
        {snapshot.imageCount > 0 && ` 本次含 ${number(snapshot.imageCount)} 张图片。`}
      </p>
    </section>
  );
}
