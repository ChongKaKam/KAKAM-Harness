import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { api, patch } from '../../client/api';
import { ErrorNote, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { PromptPreferences } from './types';
import './prompts.css';

export function PromptsSettings() {
  const { data, error } = useLoad(() => api<PromptPreferences>('/skills/preferences'));
  return (
    <div className="page prompts-settings">
      <PageHeader
        eyebrow="SKILL LIBRARY"
        title="Skill 库"
        description="选择一个轻量模型，为收藏的Skill写一句清楚的介绍。"
      />
      <ErrorNote text={error} />
      {data ? <PreferencesForm initial={data} /> : !error && <Spinner />}
    </div>
  );
}

function PreferencesForm({ initial }: { initial: PromptPreferences }) {
  const { models } = useWorkspace();
  const [selected, setSelected] = useState(initial.summaryModelId ?? '');
  const [saved, setSaved] = useState(selected);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const available = models.filter((model) => model.kind === 'llm' && model.enabled);
  const missing = selected && !available.some((model) => model.id === selected);
  return (
    <form
      className="panel prompts-settings-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
          await patch('/skills/preferences', { summaryModelId: selected || null });
          setSaved(selected);
          setMessage('简介模型已保存');
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="row">
        <BookOpen size={20} aria-hidden="true" />
        <h2>卡片简介</h2>
      </div>
      <label>
        简介模型
        <select
          value={selected}
          disabled={busy}
          onChange={(e) => {
            setSelected(e.target.value);
            setMessage('');
          }}
        >
          <option value="">不使用模型，手动填写</option>
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
        从模型管理中选择你有权限的模型，建议使用速度快的轻量模型。此设置仅对你的账户生效。
      </p>
      <p className="muted">
        编辑卡片时点击“生成简介”才会调用模型，将当前标题和正文交给所选模型。生成的介绍可以修改，保存后显示在卡片上；实际
        Token 用量计入统计。
      </p>
      {!available.length && (
        <p className="notice">当前没有可用的聊天模型，请联系管理员添加或授权模型。</p>
      )}
      <ErrorNote text={error} />
      <div className="modal-actions">
        <span className="prompts-save-status" role="status">
          {message}
        </span>
        <button
          type="submit"
          className="button primary"
          disabled={busy || !!missing || selected === saved}
        >
          {busy ? '保存中…' : '保存设置'}
        </button>
      </div>
    </form>
  );
}
