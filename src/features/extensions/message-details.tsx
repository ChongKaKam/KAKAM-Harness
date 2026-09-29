import type { ExtensionRun } from '../../shared/types';
import './extensions.css';
const statuses = {
  deciding: '正在判断',
  running: '正在执行',
  complete: '完成',
  skipped: '无需启用',
  error: '失败',
  cancelled: '已停止',
};
export function ExtensionDetails({ runs }: { runs?: ExtensionRun[] }) {
  if (!runs?.length) return null;
  return (
    <div className="extensions-results">
      {runs.map((run) => (
        <details key={run.id} className="extensions-result">
          <summary>
            <span>{run.name}</span>
            <span className="extensions-status" data-status={run.status}>
              {statuses[run.status]}
            </span>
            <span>{run.sources.length > 0 ? `${run.sources.length} 个来源` : ''}</span>
          </summary>
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
        </details>
      ))}
    </div>
  );
}
