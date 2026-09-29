import { useState, type FormEvent } from 'react';
import { Puzzle, Globe, ArrowUpRight, Settings2 } from 'lucide-react';
import { api, patch } from '../../client/api';
import { PageHeader, ErrorNote, Spinner, Empty, Modal, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { useExtensions } from './use-extensions';
import { ExtensionModeControl } from './mode-control';
import type { ExtensionInfo, ExtensionPolicy, Model } from '../../shared/types';
import './extensions.css';
type ManagedExtension = ExtensionInfo & { policy: ExtensionPolicy };
export function ExtensionsPage() {
  const { user, features, navigate, refresh, notify } = useWorkspace();
  const controls = useExtensions(user.id, features);
  const { data, error, reload } = useLoad(async () => {
    const [capabilities, models] = await Promise.all([
      api<ManagedExtension[]>('/admin/extensions'),
      api<Model[]>('/models?kind=all'),
    ]);
    return { capabilities, models };
  }, [features.map((f) => `${f.id}:${f.enabled}`).join(',')]);
  const [editing, setEditing] = useState<ManagedExtension>();
  const [strategy, setStrategy] = useState<ExtensionPolicy['strategy']>('llm');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  async function save(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(id);
    setFailure('');
    try {
      await patch(`/admin/extensions/${id}`, {
        enabled: form.has('enabled'),
        strategy: form.get('strategy'),
        llmModelId: form.get('llmModelId') || null,
        decisionModelId: form.get('decisionModelId') || null,
      });
      setEditing(undefined);
      reload();
      window.dispatchEvent(new Event('drift:extensions-changed'));
      notify('拓展能力配置已保存');
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="page extensions-page">
      <PageHeader
        eyebrow="LLM CAPABILITIES"
        title="拓展能力"
        description="通过统一入口管理聊天拓展。选择默认模式，或分别调整每项能力的设置。"
      />
      {!editing && <ErrorNote text={error || failure || controls.error} />}
      <p className="small muted extensions-help">
        默认模式与当前账户的聊天拓展菜单同步。Auto 自动判断，On 始终开启，Off 始终关闭。
      </p>
      {!data && !error && <Spinner />}
      {data && (
        <div className="panel extensions-list" aria-label="托管拓展能力">
          <div className="extensions-list-heading" aria-hidden="true">
            <span>能力</span>
            <span>状态</span>
            <span>默认模式</span>
            <span>设置</span>
          </div>
          {data.capabilities.map((item) => {
            const Icon = item.icon === 'globe' ? Globe : Puzzle;
            return (
              <section className="extensions-list-row" key={item.id} aria-label={item.name}>
                <div className="extensions-list-name">
                  <Icon size={20} />
                  <div>
                    <h2>{item.name}</h2>
                    <p>{item.description}</p>
                  </div>
                </div>
                <span className="badge extensions-availability">
                  {!item.enabled ? '已关闭' : item.ready ? '已配置' : '待配置'}
                </span>
                <ExtensionModeControl
                  name={item.name}
                  mode={controls.preferences[item.id] ?? 'off'}
                  disabled={!!busy || controls.loading}
                  saving={controls.saving}
                  change={(mode) => void controls.change(item.id, mode)}
                />
                <div className="extensions-list-actions">
                  <button
                    className="button"
                    disabled={!!busy}
                    onClick={() => {
                      setEditing(item);
                      setStrategy(item.policy.strategy);
                      setFailure('');
                    }}
                  >
                    <Settings2 size={15} />
                    能力设置
                  </button>
                  <button className="button" onClick={() => navigate('settings', item.settingsId)}>
                    插件设置
                    <ArrowUpRight size={15} />
                  </button>
                </div>
              </section>
            );
          })}
          {features
            .filter((f) => f.capability && !f.enabled)
            .map((item) => (
              <section className="extensions-list-row extensions-list-disabled" key={item.id}>
                <div className="extensions-list-name">
                  <Puzzle size={20} />
                  <div>
                    <h2>{item.name}</h2>
                    <p>插件已停用，已有配置保留。</p>
                  </div>
                </div>
                <span className="badge">已停用</span>
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(item.id);
                    setFailure('');
                    try {
                      await patch(`/features/${item.id}`, { enabled: true });
                      await refresh();
                      reload();
                    } catch (error) {
                      setFailure((error as Error).message);
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  启用插件
                </button>
              </section>
            ))}
        </div>
      )}
      {data && !data.capabilities.length && !features.some((f) => f.capability) && (
        <Empty title="暂无托管能力">启用拓展插件后会在这里显示。</Empty>
      )}
      {editing && data && (
        <Modal
          title={`${editing.name} 能力设置`}
          close={() => {
            if (!busy) setEditing(undefined);
          }}
        >
          <form
            className="extensions-policy-form"
            onSubmit={(event) => void save(editing.id, event)}
          >
            <ErrorNote text={failure} />
            <fieldset disabled={!!busy}>
              <label className="check-row">
                <input type="checkbox" name="enabled" defaultChecked={editing.policy.enabled} />
                允许在聊天中使用
              </label>
              <label>
                Auto 决策方式
                <select
                  name="strategy"
                  value={strategy}
                  onChange={(event) =>
                    setStrategy(event.target.value as ExtensionPolicy['strategy'])
                  }
                >
                  <option value="llm">LLM → JSON</option>
                  <option value="llm-jev">LLM 英文预处理 → Jev → JSON</option>
                </select>
              </label>
              <label>
                辅助 LLM
                <select name="llmModelId" defaultValue={editing.policy.llmModelId ?? ''}>
                  <option value="">跟随本次聊天模型</option>
                  {editing.policy.llmModelId &&
                    !data.models.some((m) => m.id === editing.policy.llmModelId) && (
                      <option value={editing.policy.llmModelId}>原模型已不可用，请重新选择</option>
                    )}
                  {data.models
                    .filter((m) => m.kind === 'llm')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.providerName}
                      </option>
                    ))}
                </select>
              </label>
              <p className="small muted">
                用于自动判断、英文预处理和搜索词生成。每次调用都校验当前用户的模型授权并记录用量。
              </p>
              {strategy === 'llm-jev' && (
                <label>
                  Jev 决策模型
                  <select
                    name="decisionModelId"
                    defaultValue={editing.policy.decisionModelId ?? ''}
                    required
                  >
                    <option value="">请选择决策模型</option>
                    {editing.policy.decisionModelId &&
                      !data.models.some((m) => m.id === editing.policy.decisionModelId) && (
                        <option value={editing.policy.decisionModelId}>
                          原模型已不可用，请重新选择
                        </option>
                      )}
                    {data.models
                      .filter((m) => m.kind === 'jev')
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} · {m.providerName}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <div className="modal-actions">
                <button type="button" className="button" onClick={() => setEditing(undefined)}>
                  取消
                </button>
                <button className="button primary">{busy ? '保存中…' : '保存能力配置'}</button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
    </div>
  );
}
