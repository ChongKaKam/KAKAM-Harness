import { useEffect, useState } from 'react';
import { api, patch } from '../../client/api';
import { ErrorNote, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { MemoryOperation, MemoryPreparation, MemoryScopeState } from '../../shared/memory';
import { MemoryProposals, OperationProgress, scopeLabels } from '../memory/client';

const recallLabels = {
  skipped: '已跳过',
  ready: '已就绪',
  degraded: '降级召回',
  error: '召回失败',
};
const operationLabels = {
  running: '抽取中',
  prepared: '已准备',
  applied: '已应用',
  complete: '已完成',
  error: '抽取失败',
  cancelled: '已取消',
};

export function MemoryTrace({
  memory,
  conversationId,
}: {
  memory: MemoryPreparation;
  conversationId: string;
}) {
  const { features } = useWorkspace();
  const enabled = features.some((feature) => feature.id === 'memory' && feature.enabled);
  const [state, setState] = useState<MemoryScopeState>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || memory.status === 'skipped') return;
    const controller = new AbortController();
    api<MemoryScopeState>(`/memory/v1/sessions/${encodeURIComponent(conversationId)}/state`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setState(result);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [conversationId, enabled, memory.status]);
  async function select(memoryId: string, selection: 'prefer' | 'exclude' | null) {
    if (!state || busy) return;
    setBusy(memoryId);
    setError('');
    try {
      const next = await patch<MemoryScopeState>(
        `/memory/v1/sessions/${encodeURIComponent(conversationId)}/state`,
        { revision: state.revision, selections: { [memoryId]: selection } },
      );
      setState(next);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="context-manager-memory-trace" aria-label="本轮记忆召回">
      <h3>记忆召回</h3>
      <p className="context-manager-caption">
        策略 {memory.strategyId} · v{memory.strategyVersion} · {recallLabels[memory.status]} ·{' '}
        {memory.durationMs.toLocaleString('zh-CN')} ms · 注入 {memory.blocks.length} 条
        {memory.omittedIds.length > 0 && ` · 预算遗漏 ${memory.omittedIds.length} 条`}
      </p>
      {memory.configVersion !== undefined && (
        <p className="context-manager-caption">策略配置修订 {memory.configVersion}</p>
      )}
      {memory.timings && (
        <p className="context-manager-caption">
          Embedding {memory.timings.embeddingMs} ms · 数据库检索 {memory.timings.searchMs} ms · LLM
          选择 {memory.timings.selectionMs} ms · 范围与预算校验 {memory.timings.validationMs} ms
        </p>
      )}
      {memory.error && <ErrorNote text={memory.error} />}
      {memory.blocks.map((block) => (
        <div className="context-manager-memory-choice" key={block.memoryId}>
          <p className="context-manager-caption">
            <strong>{scopeLabels[block.scope]}</strong> · {block.memoryId.slice(0, 8)} · v
            {block.version} · {block.reason || '无选择说明'}
          </p>
          {!!block.content && block.content !== '[记忆已删除]' && enabled && state && (
            <div className="context-manager-memory-actions">
              <button
                type="button"
                className="button"
                aria-pressed={state.selections[block.memoryId] === 'prefer'}
                disabled={!!busy}
                onClick={() =>
                  void select(
                    block.memoryId,
                    state.selections[block.memoryId] === 'prefer' ? null : 'prefer',
                  )
                }
              >
                本 Session 优先
              </button>
              <button
                type="button"
                className="button"
                aria-pressed={state.selections[block.memoryId] === 'exclude'}
                disabled={!!busy}
                onClick={() =>
                  void select(
                    block.memoryId,
                    state.selections[block.memoryId] === 'exclude' ? null : 'exclude',
                  )
                }
              >
                本 Session 排除
              </button>
            </div>
          )}
        </div>
      ))}
      {memory.blocks.length > 0 && (
        <p className="context-manager-caption">
          优先 / 排除从后续轮次生效；当前快照保留本轮实际输入。
        </p>
      )}
      <ErrorNote text={error} />
    </section>
  );
}

export function MemoryAfterTurn({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const { data, error, reload } = useLoad(
    () =>
      api<MemoryOperation[]>(
        `/memory/v1/operations?${new URLSearchParams({ conversationId, messageId })}`,
      ),
    [conversationId, messageId],
  );
  useEffect(() => {
    if (!data?.some((operation) => operation.state === 'running')) return;
    const timer = window.setTimeout(reload, 3000);
    return () => window.clearTimeout(timer);
  }, [data]);
  return (
    <section className="context-manager-memory-after" aria-label="回答后记忆抽取">
      <h3>回答后的记忆处理</h3>
      <p className="context-manager-caption">
        抽取与写入发生在回答完成后，不计入上方本轮输入字符与字节。
      </p>
      <ErrorNote text={error} />
      {!data && !error && <Spinner />}
      {data
        ?.filter((operation) => operation.type === 'extract')
        .map((operation) => (
          <div key={operation.id} className="context-manager-memory-choice">
            <p className="context-manager-caption" role="status">
              {operationLabels[operation.state]} ·{' '}
              {new Date(operation.createdAt).toLocaleString('zh-CN', { hour12: false })}
            </p>
            <OperationProgress operation={operation} />
            <ErrorNote text={operation.error ?? ''} />
          </div>
        ))}
      <MemoryProposals
        key={data?.map((operation) => `${operation.id}:${operation.state}`).join(',')}
        conversationId={conversationId}
        messageId={messageId}
        compact
      />
    </section>
  );
}
