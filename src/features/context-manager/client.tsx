import { useState } from 'react';
import { GitBranch } from 'lucide-react';
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
        description="回看每轮对话的上下文，整理一份交给下一个 Agent 的交接文档。"
      />
      <ErrorNote text={error} />
      {data ? <PreferencesForm initial={data} /> : !error && <Spinner />}
    </div>
  );
}

function PreferencesForm({ initial }: { initial: ContextPreferences }) {
  const { models } = useWorkspace();
  const available = models.filter((model) => model.kind === 'llm' && model.enabled);
  const [selected, setSelected] = useState(initial.handoffModelId ?? '');
  const [saved, setSaved] = useState(selected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const missing = !!selected && !available.some((model) => model.id === selected);
  return (
    <form
      className="panel context-manager-settings-panel"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || missing) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
          await patch('/context-manager/preferences', { handoffModelId: selected || null });
          setSaved(selected);
          setMessage('Hand-off 模型已保存');
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="row">
        <GitBranch size={20} aria-hidden="true" />
        <h2>交接模型</h2>
      </div>
      <label>
        默认 Hand-off 模型
        <select
          value={selected}
          disabled={busy}
          onChange={(event) => {
            setSelected(event.target.value);
            setMessage('');
          }}
        >
          <option value="">每次生成时选择</option>
          {missing && (
            <option value={selected} disabled>
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
      <p className="muted">
        使用模型管理中你有权限的 LLM。仅在点击“生成
        Hand-off”时调用，将截至所选轮次的对话轨迹与上下文交给该模型；实际 Token 用量计入统计。
      </p>
      <p className="muted">
        插件启用期间自动记录每轮上下文。聊天回复旁的“上下文”可查看历史组成和交接文档。插件不会自行注入
        System prompt 或长期记忆，未注入的部分保持为空；启用前的历史轮次没有快照。
      </p>
      {!available.length && (
        <p className="notice">当前没有可用 LLM，请联系管理员添加或授权模型。</p>
      )}
      <ErrorNote text={error} />
      <div className="modal-actions">
        <span className="muted" role="status">
          {message}
        </span>
        <button
          type="submit"
          className="button primary"
          disabled={busy || missing || selected === saved}
        >
          {busy ? '保存中…' : '保存设置'}
        </button>
      </div>
    </form>
  );
}
