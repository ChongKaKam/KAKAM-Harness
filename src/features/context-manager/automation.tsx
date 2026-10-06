import { useEffect, useRef, useState } from 'react';
import { api } from '../../client/api';
import { ErrorNote } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { ContextTrajectory } from '../../shared/context';
import type { ContextPreferences, ContextSnapshot } from './types';

export function ContextAutomation({
  snapshot,
  path,
  refreshed,
}: {
  snapshot: ContextSnapshot;
  path: string;
  refreshed(): void;
}) {
  const { models } = useWorkspace();
  const available = models.filter((model) => model.kind === 'llm' && model.enabled);
  const [modelId, setModelId] = useState('');
  const [trajectory, setTrajectory] = useState(snapshot.trajectory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const active = useRef(true);
  useEffect(() => setTrajectory(snapshot.trajectory), [snapshot.trajectory]);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    api<ContextPreferences>('/context-manager/preferences', { signal: controller.signal })
      .then((prefs) => {
        if (!controller.signal.aborted) setModelId(prefs.trajectoryModelId ?? '');
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => {
      active.current = false;
      controller.abort();
      request.current?.abort();
    };
  }, []);
  const compression = snapshot.compression;
  const missing = !!modelId && !available.some((model) => model.id === modelId);
  return (
    <>
      {compression && (
        <section className="context-manager-compression" aria-label="上下文压缩记录">
          <h3>
            上下文压缩 ·{' '}
            {
              {
                compressed: '本轮已压缩',
                reused: '复用已有摘要',
                skipped: '本轮跳过',
                error: '本轮失败',
              }[compression.status]
            }
          </h3>
          <p className="context-manager-caption">
            {compression.beforeCharacters.toLocaleString('zh-CN')} →{' '}
            {compression.afterCharacters.toLocaleString('zh-CN')} 字符 · 压缩{' '}
            {compression.compressedMessages} 条历史，保留 {compression.retainedMessages} 条原文
            {compression.modelName ? ` · ${compression.modelName}` : ''}
          </p>
          {compression.error && <p className="context-manager-caption">{compression.error}</p>}
          {compression.usage && (
            <p className="context-manager-caption">
              压缩模型上报 Token · 输入 {compression.usage.input} / 输出 {compression.usage.output}{' '}
              / 合计 {compression.usage.total}
            </p>
          )}
        </section>
      )}
      <section className="context-manager-trajectory" aria-label="轨迹节点摘要">
        <h3>轨迹节点摘要{trajectory?.status === 'pending' ? ' · 生成中' : ''}</h3>
        {trajectory?.status === 'ready' ? (
          <dl>
            <div>
              <dt>标题</dt>
              <dd>{trajectory.title}</dd>
            </div>
            <div>
              <dt>用户意图</dt>
              <dd>{trajectory.intent}</dd>
            </div>
            <div>
              <dt>回答摘要</dt>
              <dd>{trajectory.answerSummary}</dd>
            </div>
          </dl>
        ) : (
          <p className="context-manager-caption">
            {trajectory?.status === 'pending'
              ? '回答已完成，模型正在整理本轮摘要。'
              : trajectory?.error || '尚未生成模型摘要，轨迹标题沿用原始提问。'}
          </p>
        )}
        {trajectory?.modelName && (
          <p className="context-manager-caption">
            {trajectory.modelName} ·{' '}
            {trajectory.inputTruncated
              ? '输入较长，摘要依据截取片段生成，请核对原文。'
              : '模型摘要供回看，原文保存在当前 prompt 与本轮回复中。'}
          </p>
        )}
        {trajectory?.usage && (
          <p className="context-manager-caption">
            摘要模型上报 Token · 输入 {trajectory.usage.input} / 输出 {trajectory.usage.output} /
            合计 {trajectory.usage.total}
          </p>
        )}
        <label className="context-manager-summary-model">
          本轮轨迹摘要模型
          <select
            value={modelId}
            disabled={busy || trajectory?.status === 'pending'}
            onChange={(event) => setModelId(event.target.value)}
          >
            <option value="">选择已授权的 LLM</option>
            {missing && (
              <option value={modelId} disabled>
                原模型已停用或未授权
              </option>
            )}
            {available.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} · {model.providerName}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          disabled={
            busy ||
            trajectory?.status === 'pending' ||
            !modelId ||
            missing ||
            snapshot.status !== 'complete'
          }
          onClick={async () => {
            const controller = new AbortController();
            request.current = controller;
            setBusy(true);
            setError('');
            try {
              const result = await api<ContextTrajectory>(
                `${path}/turns/${encodeURIComponent(snapshot.messageId)}/summary`,
                { method: 'POST', body: JSON.stringify({ modelId }), signal: controller.signal },
              );
              if (!controller.signal.aborted && active.current) {
                setTrajectory(result);
                refreshed();
              }
            } catch (error) {
              if (!controller.signal.aborted && active.current) setError((error as Error).message);
            } finally {
              if (!controller.signal.aborted && active.current) setBusy(false);
            }
          }}
        >
          {busy
            ? '生成摘要中…'
            : trajectory?.status === 'ready'
              ? '重新生成节点摘要'
              : '生成节点摘要'}
        </button>
        <ErrorNote text={error} />
      </section>
    </>
  );
}
