import { ChevronDown, LoaderCircle } from 'lucide-react';
import type { ExtensionRun } from '../../shared/types';
import { ExtensionIcon } from './extension-icon';
import './extensions.css';
const statuses = {
  deciding: '正在判断',
  running: '正在执行',
  complete: '完成',
  skipped: '无需启用',
  error: '失败',
  cancelled: '已停止',
};

function activity(run: ExtensionRun): string {
  if (run.status !== 'deciding' && run.status !== 'running')
    return run.status === 'complete' && run.id === 'search' ? '搜索完成' : statuses[run.status];
  const current = run.calls.findLast((call) => call.status === 'streaming');
  switch (current?.stage) {
    case '英文预处理':
      return '正在理解问题';
    case '自动决策':
    case 'Jev 决策':
      return run.id === 'search' ? '正在判断是否需要搜索' : '正在判断是否启用';
    case '搜索词':
      return '正在生成搜索词';
    case '检索': {
      const index = run.calls.filter((call) => call.stage === '检索').length;
      return run.queries.length ? `正在搜索 ${index}/${run.queries.length}` : '正在搜索';
    }
    default:
      if (current) return `正在执行：${current.stage}`;
      if (run.status === 'deciding')
        return run.id === 'search' ? '正在判断是否需要搜索' : '正在判断是否启用';
      if (run.id === 'search') return run.queries.length ? '正在整理搜索结果' : '准备搜索';
      return statuses[run.status];
  }
}

export function ExtensionDetails({ runs }: { runs?: ExtensionRun[] }) {
  if (!runs?.length) return null;
  return (
    <div className="extensions-results">
      {runs.map((run) => (
        <details key={run.id} className="extensions-result">
          <summary className="extensions-result-summary">
            <ExtensionIcon className="extensions-result-icon" />
            <span className="extensions-summary-copy">
              <strong>{run.name}</strong>
              <span
                className="extensions-status"
                data-status={run.status}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {(run.status === 'deciding' || run.status === 'running') && (
                  <LoaderCircle size={14} className="extensions-activity" aria-hidden="true" />
                )}
                {activity(run)}
              </span>
              {run.sources.length > 0 && (
                <span className="extensions-source-count">{run.sources.length} 个来源</span>
              )}
            </span>
            <ChevronDown size={16} className="extensions-result-chevron" aria-hidden="true" />
          </summary>
          <div
            className="extensions-result-body"
            role="region"
            aria-label={`${run.name} 执行详情`}
            tabIndex={0}
          >
            {run.error && <p className="error-note">{run.error}</p>}
            {run.decision && (
              <p className="small muted">自动判断：{run.decision.enabled ? '开启' : '关闭'}</p>
            )}
            {!!run.queries.length && (
              <div>
                <strong>搜索词</strong>
                <ol>
                  {run.queries.map((query) => (
                    <li key={query}>{query}</li>
                  ))}
                </ol>
              </div>
            )}
            {!!run.sources.length && (
              <div>
                <strong>信息来源</strong>
                <ol className="extensions-sources">
                  {run.sources.map((source) => (
                    <li key={source.url}>
                      <a href={source.url} target="_blank" rel="noopener noreferrer">
                        {source.title || source.url}
                      </a>
                      <small>
                        {new URL(source.url).hostname}
                        {source.date ? ` · ${source.date}` : ''}
                      </small>
                      <p>{source.snippet}</p>
                    </li>
                  ))}
                </ol>
                <p className="small muted">
                  来源来自搜索结果，回答基于摘要生成；请打开原文核实重要信息。
                </p>
              </div>
            )}
            {!!run.calls.length && (
              <div className="extensions-calls">
                <strong>拓展调用 · Token</strong>
                {run.calls.map((call) => (
                  <div key={call.id} className="extensions-call">
                    <span>
                      {call.stage} · {call.modelName}
                    </span>
                    <span>
                      {call.usage
                        ? `输入 ${call.usage.input} / 输出 ${call.usage.output} / 合计 ${call.usage.total}`
                        : '未上报'}{' '}
                      ·{' '}
                      {call.status === 'complete'
                        ? '完成'
                        : call.status === 'streaming'
                          ? '执行中'
                          : call.status === 'cancelled'
                            ? '已停止'
                            : '失败'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
