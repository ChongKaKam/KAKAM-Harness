import { useState } from 'react';
import { api, patch } from '../../client/api';
import { ErrorNote, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { ContextPreferences } from './types';
import './context-manager.css';

export function ContextManagerSettings() {
  const { user } = useWorkspace();
  return <SettingsContent key={user.id} />;
}
function SettingsContent() {
  const { data, error } = useLoad(() => api<ContextPreferences>('/context-manager/preferences'));
  return (
    <div className="page context-manager-settings">
      <PageHeader
        eyebrow="CONTEXT MANAGER"
        title="上下文管理"
        description="管理自动压缩、对话轨迹摘要与 Agent 交接。"
      />
      <ErrorNote text={error} />
      {data ? <PreferencesForm initial={data} /> : !error && <Spinner />}
    </div>
  );
}
function PreferencesForm({ initial }: { initial: ContextPreferences }) {
  const { models } = useWorkspace();
  const available = models.filter((model) => model.kind === 'llm' && model.enabled);
  const [preferences, setPreferences] = useState(initial);
  const [persisted, setPersisted] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = JSON.stringify(preferences) !== JSON.stringify(persisted);
  const modelField = (
    key: 'handoffModelId' | 'compressionModelId' | 'trajectoryModelId',
    label: string,
  ) => {
    const id = preferences[key] ?? '';
    const missing = id && !available.some((model) => model.id === id);
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
          <option value="">
            {key === 'handoffModelId' ? '每次生成时选择' : '选择已授权的 LLM'}
          </option>
          {missing && (
            <option value={id} disabled>
              原模型已停用或未授权，请重新选择
            </option>
          )}
          {available.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} · {model.providerName}
            </option>
          ))}
        </select>
      </label>
    );
  };
  const numeric = (
    key: 'compressionThreshold' | 'compressionKeepTurns' | 'compressionMaxCharacters',
    label: string,
    min: number,
    max: number,
  ) => (
    <label>
      {label}
      <input
        type="number"
        value={preferences[key]}
        min={min}
        max={max}
        required
        disabled={busy}
        onChange={(event) => setPreferences({ ...preferences, [key]: Number(event.target.value) })}
      />
    </label>
  );
  return (
    <form
      className="context-manager-settings-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
          const result = await patch<ContextPreferences>(
            '/context-manager/preferences',
            preferences,
          );
          setPreferences(result);
          setPersisted(result);
          setMessage('上下文设置已保存');
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="context-manager-settings-toolbar">
        <p className="context-manager-caption" role="status">
          {message || (dirty ? '有未保存修改，保存后从下一轮对话生效' : '当前设置已保存')}
        </p>
        <button type="submit" className="button primary" disabled={busy || !dirty}>
          {busy ? '保存中…' : '保存设置'}
        </button>
      </div>
      <ErrorNote text={error} />
      <div className="context-manager-settings-grid">
        <section className="context-manager-settings-panel context-manager-compression-settings">
          <h2>自动上下文压缩</h2>
          <label className="context-manager-check">
            <input
              type="checkbox"
              checked={preferences.compressionEnabled}
              disabled={busy}
              onChange={(event) =>
                setPreferences({ ...preferences, compressionEnabled: event.target.checked })
              }
            />
            启用自动上下文压缩
          </label>
          <div className="context-manager-fields">
            {modelField('compressionModelId', '上下文压缩模型')}
            {numeric('compressionThreshold', '压缩触发阈值（字符）', 2000, 1000000)}
            {numeric('compressionKeepTurns', '保留最近原文（轮）', 1, 20)}
            {numeric('compressionMaxCharacters', '压缩摘要预算（字符）', 500, 16000)}
          </div>
          <p className="context-manager-caption">
            发送前达到阈值时，用 LLM
            压缩较早历史，保留最近若干轮与图片原文。后续复用摘要，需要时增量压缩；失败继续使用原历史，原聊天记录保留。
          </p>
          <p className="context-manager-caption">
            阈值按发给回答模型的消息文本计量（UTF-16 字符，含本轮记忆与 Skill / Search
            内容），不代表 Token 或模型容量。摘要预算须小于触发阈值。
          </p>
        </section>
        <section className="context-manager-settings-panel">
          <h2>轨迹节点摘要</h2>
          <label className="context-manager-check">
            <input
              type="checkbox"
              checked={preferences.trajectoryEnabled}
              disabled={busy}
              onChange={(event) =>
                setPreferences({ ...preferences, trajectoryEnabled: event.target.checked })
              }
            />
            回答完成后自动生成节点摘要
          </label>
          {modelField('trajectoryModelId', '轨迹摘要模型')}
          <p className="context-manager-caption">
            模型输出标题、用户意图和回答摘要，保存在对应轨迹节点。摘要与原始提问分别显示；失败可在上下文抽屉手动重试。
          </p>
        </section>
        <section className="context-manager-settings-panel">
          <h2>Agent 交接</h2>
          {modelField('handoffModelId', '默认 Hand-off 模型')}
          <p className="context-manager-caption">
            点击“生成 Hand-off”时，整理截至所选轮次的意图、进度与后续方向，供复制或下载。
          </p>
        </section>
      </div>
      <p className="context-manager-caption">
        模型均来自当前账户已授权的
        LLM，实际辅助调用计入用量。插件启用时记录新轮次；自动压缩与轨迹摘要默认关闭，保存设置不会调用模型。
      </p>
      {!available.length && (
        <p className="notice">当前没有可用 LLM，请联系管理员添加或授权模型。</p>
      )}
    </form>
  );
}
