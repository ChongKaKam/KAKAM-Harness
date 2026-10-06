import { useEffect, useState } from 'react';
import { api, patch } from '../../client/api';
import { ErrorNote, Spinner } from '../../client/components';
import type { Model } from '../../shared/types';
import type { MemoryPreferences, MemoryStrategyInfo, MemoryWriteMode } from '../../shared/memory';
import { memoryStrategyClient } from './strategy-ui';

export function MemorySettings({
  initial,
  models,
  strategies,
  saved,
}: {
  initial: MemoryPreferences;
  models: Model[];
  strategies: MemoryStrategyInfo[];
  saved(): void;
}) {
  const [preferences, setPreferences] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const selected = strategies.find((item) => item.id === preferences.strategyId);
  const paired = selected && memoryStrategyClient(selected);
  const available = models.filter((model) => model.enabled);
  const modelField = (
    key: 'embeddingModelId' | 'recallModelId' | 'extractModelId',
    label: string,
    kind: Model['kind'],
  ) => {
    const id = preferences[key] ?? '';
    const options = available.filter((model) => model.kind === kind);
    const missing = id && !options.some((model) => model.id === id);
    return (
      <label>
        {label}
        <select
          value={id}
          disabled={busy}
          onChange={(event) =>
            setPreferences({ ...preferences, [key]: event.target.value || null })
          }
        >
          <option value="">选择已授权的模型</option>
          {missing && (
            <option value={id} disabled>
              原模型已停用或未授权，请重新选择
            </option>
          )}
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} · {model.providerName}
              {model.kind === 'embedding' &&
                ` · ${model.validatedDimensions ? `${model.validatedDimensions} 维` : '维度未验证'}`}
            </option>
          ))}
        </select>
      </label>
    );
  };
  const missing = [
    preferences.embeddingModelId,
    preferences.recallModelId,
    preferences.extractModelId,
  ].some((id) => !!id && !available.some((model) => model.id === id));
  return (
    <>
      <form
        className="memory-settings-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || missing || !paired) return;
          setBusy(true);
          setError('');
          setMessage('');
          try {
            await patch('/memory/v1/preferences', preferences);
            setMessage('记忆设置已保存');
            saved();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <section className="memory-settings-section">
          <h2>对话记忆</h2>
          <label className="memory-check">
            <input
              type="checkbox"
              checked={preferences.enabled}
              disabled={busy}
              onChange={(event) =>
                setPreferences({ ...preferences, enabled: event.target.checked })
              }
            />
            启用对话召回与抽取
          </label>
          <p className="muted">
            发送前召回已保存的记忆，回答完成后抽取新记忆。辅助 LLM 与 embedding 调用计入实际用量。
          </p>
          <div className="memory-form-grid">
            {modelField('embeddingModelId', 'Embedding 模型', 'embedding')}
            {modelField('recallModelId', '记忆检索 LLM', 'llm')}
            {modelField('extractModelId', '记忆抽取 LLM', 'llm')}
          </div>
          <p className="memory-caption">
            供应商、密钥和模型授权在现有模型管理中设置。Embedding
            模型切换后需重建新向量空间；旧向量不会混用。
          </p>
        </section>
        <section className="memory-settings-section">
          <h2>记忆策略 / Agent</h2>
          <label>
            当前策略
            <select
              value={preferences.strategyId}
              disabled={busy}
              onChange={(event) =>
                setPreferences({ ...preferences, strategyId: event.target.value })
              }
            >
              {!selected && (
                <option value={preferences.strategyId} disabled>
                  原策略不可用，请重新选择
                </option>
              )}
              {strategies.map((strategy) => (
                <option
                  key={strategy.id}
                  value={strategy.id}
                  disabled={!memoryStrategyClient(strategy)}
                >
                  {strategy.name} · v{strategy.version}
                  {!memoryStrategyClient(strategy) ? '（缺少设置界面）' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">{selected?.description}</p>
          {!paired && <ErrorNote text="此策略没有配套设置界面，无法启用。请选用完整注册的策略。" />}
        </section>
        <section className="memory-settings-section">
          <h2>抽取与保留</h2>
          <div className="memory-form-grid">
            {(['user', 'group', 'session'] as const).map((scope) => (
              <label key={scope}>
                {{ user: '长期记忆', group: '分组记忆', session: 'Session 记忆' }[scope]}写入方式
                <select
                  value={preferences.writeModes[scope]}
                  disabled={busy}
                  onChange={(event) =>
                    setPreferences({
                      ...preferences,
                      writeModes: {
                        ...preferences.writeModes,
                        [scope]: event.target.value as MemoryWriteMode,
                      },
                    })
                  }
                >
                  <option value="off">不抽取</option>
                  <option value="confirm">抽取候选，确认后保存</option>
                  <option value="auto">自动保存</option>
                </select>
              </label>
            ))}
            {(['group', 'session'] as const).map((scope) => (
              <label key={scope}>
                {scope === 'group' ? '分组' : 'Session'}闲置保留（天）
                <input
                  type="number"
                  required
                  min={1}
                  max={3650}
                  disabled={busy}
                  value={preferences.retentionDays[scope]}
                  onChange={(event) =>
                    setPreferences({
                      ...preferences,
                      retentionDays: {
                        ...preferences.retentionDays,
                        [scope]: Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <p className="memory-caption">
            长期记忆默认长期保留。分组与 Session
            记忆按照范围的最近活动时间清理；召回近期窗口单独设置。
          </p>
        </section>
        <ErrorNote text={error} />
        <div className="memory-actions">
          <span role="status" className="memory-caption">
            {message}
          </span>
          <button className="button primary" type="submit" disabled={busy || missing || !paired}>
            {busy ? '保存中…' : '保存记忆设置'}
          </button>
        </div>
      </form>
      {selected && paired && <StrategyConfiguration key={selected.id} strategy={selected} />}
    </>
  );
}

function StrategyConfiguration({ strategy }: { strategy: MemoryStrategyInfo }) {
  const definition = memoryStrategyClient(strategy)!;
  const Settings = definition.Settings;
  const [value, setValue] = useState<{ version: number; config: Record<string, unknown> }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<{ version: number; config: Record<string, unknown> }>(
      `/memory/v1/strategies/${encodeURIComponent(strategy.id)}/config`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setValue(result);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [strategy.id]);
  return (
    <form
      className="memory-settings-section memory-strategy-panel"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!value || busy) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
          const result = await patch<{ version: number; config: Record<string, unknown> }>(
            `/memory/v1/strategies/${encodeURIComponent(strategy.id)}/config`,
            value,
          );
          setValue(result);
          setMessage('策略内部设置已保存');
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>策略内部设置</h2>
      {!value && !error && <Spinner />}
      {value && (
        <Settings
          config={value.config}
          defaults={strategy.defaultConfig}
          disabled={busy}
          onChange={(config) => setValue({ ...value, config })}
        />
      )}
      <ErrorNote text={error} />
      <div className="memory-actions">
        <span role="status" className="memory-caption">
          {message}
        </span>
        <button type="submit" className="button primary" disabled={!value || busy}>
          {busy ? '保存中…' : '保存策略设置'}
        </button>
      </div>
    </form>
  );
}
