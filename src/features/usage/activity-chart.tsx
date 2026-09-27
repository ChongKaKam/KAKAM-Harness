import { useEffect, useMemo, useRef, useState } from 'react';
import type { UsageData } from '../../shared/types';
import { buildActivity, type ActivityCell, type ActivityMode } from './activity';
import { usePatternColors } from '../../client/color-pattern';
const number = (n: number) => n.toLocaleString('zh-CN');
export function ActivityChart({ rows, days }: { rows: UsageData['activity']; days: number }) {
  const pattern = usePatternColors();
  const modelColor = (model: string) => pattern.resolve({ key: model }).color.color;
  const [mode, setMode] = useState<ActivityMode>('daily');
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = scroll.current.scrollWidth;
    setSelected(undefined);
  }, [rows, days, mode]);
  const [selected, setSelected] = useState<ActivityCell>();
  const cells = useMemo(() => buildActivity(rows, days, mode), [rows, days, mode]);
  const models = [...new Set(rows.map((r) => r.model))].sort();
  const max = Math.max(1, ...cells.map((c) => c.total));
  const offset = mode === 'weekly' ? 0 : (new Date(cells[0].day).getUTCDay() + 6) % 7;
  const columns = mode === 'weekly' ? cells.length : Math.ceil((cells.length + offset) / 7);
  const columnStyle = {
    gridTemplateColumns: `repeat(${columns}, minmax(12px, 1fr))`,
    maxWidth: columns * 20 - 4,
  };
  const months = Array.from(
    { length: columns },
    (_, index) => cells[Math.max(0, index * (mode === 'weekly' ? 1 : 7) - offset)]?.day ?? '',
  );
  function colors(cell: ActivityCell) {
    const active = Object.entries(cell.models)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    let start = 0;
    return active.length
      ? `linear-gradient(180deg, ${active
          .map(([model, total]) => {
            const end = start + (total / cell.total) * 100;
            const stop = `${modelColor(model)} ${start}% ${end}%`;
            start = end;
            return stop;
          })
          .join(',')})`
      : undefined;
  }
  return (
    <section className="panel usage-chart activity-chart">
      <div className="activity-header">
        <h3>Token 活动</h3>
        <div className="activity-modes" role="group" aria-label="活动统计模式">
          {(
            [
              { value: 'daily', label: '每日' },
              { value: 'weekly', label: '每周' },
              { value: 'cumulative', label: '累计' },
            ] as const
          ).map((item) => (
            <button
              key={item.value}
              aria-pressed={mode === item.value}
              onClick={() => {
                setMode(item.value);
                setSelected(undefined);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="activity-scroll" ref={scroll}>
        <div
          className="activity-grid"
          style={{
            ...columnStyle,
            gridTemplateRows: mode === 'weekly' ? '12px' : 'repeat(7, 12px)',
          }}
          aria-label="Token 活动热力图"
        >
          {Array.from({ length: offset }, (_, i) => (
            <span key={`empty${i}`} />
          ))}
          {cells.map((cell) => (
            <button
              key={cell.day}
              className={`activity-cell ${cell.requests && !cell.total ? 'unreported' : ''}`}
              style={{
                background: colors(cell),
                opacity: cell.total ? 0.35 + 0.65 * Math.sqrt(cell.total / max) : 1,
              }}
              aria-label={`${cell.day}${cell.end !== cell.day ? ` 至 ${cell.end}` : ''}：${number(cell.total)} Tokens，${cell.requests} 次调用`}
              title={`${cell.day}${cell.end !== cell.day ? ` — ${cell.end}` : ''}\n${number(cell.total)} Tokens · ${cell.requests} 次调用\n${Object.entries(
                cell.models,
              )
                .map(([model, total]) => `${model}: ${number(total)}`)
                .join('\n')}`}
              onFocus={() => setSelected(cell)}
              onMouseEnter={() => setSelected(cell)}
              onClick={() => setSelected(cell)}
            />
          ))}
        </div>
        <div className="activity-months" style={columnStyle}>
          {months.map((day, index) => (
            <span key={index}>
              {day && (!index || day.slice(0, 7) !== months[index - 1].slice(0, 7))
                ? `${Number(day.slice(5, 7))}月`
                : ''}
            </span>
          ))}
        </div>
      </div>
      <div className="activity-legend">
        {models.map((model) => (
          <span key={model}>
            <i style={{ background: modelColor(model) }} />
            {model}
          </span>
        ))}
        {!models.length && <span>还没有用量记录，开始一次对话后会显示活动。</span>}
      </div>
      <div className="activity-detail" aria-live="polite">
        {selected ? (
          <>
            <strong>
              {selected.day}
              {selected.end !== selected.day ? ` — ${selected.end}` : ''}
            </strong>
            <span>
              {number(selected.total)} Tokens · {selected.requests} 次调用
            </span>
            {Object.entries(selected.models).map(([model, total]) => (
              <span key={model}>
                {model}：{number(total)}
              </span>
            ))}
          </>
        ) : (
          <span>
            {mode === 'cumulative'
              ? '累计所选期间截至各日的用量'
              : mode === 'weekly'
                ? '每格代表一周（周一开始）'
                : '每格代表一天，按列从周一至周日排列'}{' '}
            · 颜色代表模型，深浅代表用量 · UTC<span className="mobile-only"> · 左右滑动查看</span>
          </span>
        )}
      </div>
    </section>
  );
}
