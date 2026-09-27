import { useState, useRef, type FormEvent } from 'react';
import {
  Plus,
  Radio,
  RefreshCw,
  Pencil,
  Trash2,
  Check,
  ShieldCheck,
  Eye,
  Server,
} from 'lucide-react';
import { api, post, patch, remove } from '../../client/api';
import { useWorkspace } from '../../client/context';
import { PageHeader, Empty, ErrorNote, Modal, Spinner, useLoad } from '../../client/components';
import type { Model, Provider, User } from '../../shared/types';
interface ManagedModel extends Model {
  userIds: string[];
}
export function ModelsPage() {
  const { refresh, notify } = useWorkspace();
  const [tab, setTab] = useState<'sources' | 'models'>('sources');
  const { data, error, reload } = useLoad(async () => {
    const [providers, models, users] = await Promise.all([
      api<Provider[]>('/admin/providers'),
      api<ManagedModel[]>('/admin/models'),
      api<User[]>('/admin/users'),
    ]);
    return { providers, models, users };
  });
  const [providerModal, setProviderModal] = useState<Provider | 'new'>();
  const [modelModal, setModelModal] = useState<ManagedModel | 'new'>();
  const [discovery, setDiscovery] = useState<{ provider: Provider; names: string[] }>();
  const [discovering, setDiscovering] = useState('');
  const providerForm = useRef<HTMLFormElement>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');
  async function updated() {
    reload();
    await refresh();
  }
  async function saveProvider(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (testing) return;
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setFormError('');
    try {
      if (providerModal === 'new') await post('/admin/providers', values);
      else
        await patch(`/admin/providers/${providerModal!.id}`, {
          ...values,
          apiKey: values.apiKey || undefined,
        });
      setProviderModal(undefined);
      await updated();
      notify('模型来源已保存');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function testConnection() {
    const form = providerForm.current;
    if (!form?.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    if (!values.model) {
      setFormError('请填写用于测试的模型名称');
      return;
    }
    setTesting(true);
    setFormError('');
    setTestResult('');
    try {
      const result = await post<{ latencyMs: number; model: string; apiMode: string }>(
        '/admin/providers/test',
        {
          ...values,
          id: providerModal !== 'new' ? providerModal?.id : undefined,
          apiKey: providerModal === 'new' ? values.apiKey : values.apiKey || undefined,
        },
      );
      setTestResult(
        `连接成功 · ${result.model} · ${result.apiMode === 'responses' ? 'Responses' : 'Chat Completions'} · ${result.latencyMs} ms`,
      );
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setTesting(false);
    }
  }
  async function saveModel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const values = Object.fromEntries(form);
    setBusy(true);
    setFormError('');
    try {
      if (modelModal === 'new')
        await post('/admin/models', { ...values, vision: form.has('vision') });
      else
        await patch(`/admin/models/${modelModal!.id}`, {
          label: values.label,
          vision: form.has('vision'),
          enabled: form.has('enabled'),
          userIds: form.getAll('userIds'),
        });
      setModelModal(undefined);
      await updated();
      notify('模型配置已保存');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function discover(p: Provider) {
    setDiscovering(p.id);
    setActionError('');
    try {
      const result = await post<{ models: string[] }>(`/admin/providers/${p.id}/discover`);
      setDiscovery({ provider: p, names: result.models });
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setDiscovering('');
    }
  }
  async function addDiscovered(name: string) {
    setBusy(true);
    setFormError('');
    try {
      await post('/admin/models', {
        providerId: discovery!.provider.id,
        name,
        label: name,
        vision: false,
      });
      await updated();
      notify('已加入白名单，可在模型管理中配置图片能力和用户授权');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function erase(path: string, description: string) {
    if (!confirm(description)) return;
    setActionError('');
    try {
      await remove(path);
      await updated();
      notify('已删除');
    } catch (e) {
      setActionError((e as Error).message);
    }
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="MODELS & CONNECTIONS"
        title="连接你的模型"
        description="从云端服务到本地模型，让合适的能力在这里汇合。"
        action={
          <button
            className="button primary"
            onClick={() => {
              setFormError('');
              if (tab === 'sources') {
                setTestResult('');
                setProviderModal('new');
              } else setModelModal('new');
            }}
            disabled={tab === 'models' && !data?.providers.length}
          >
            <Plus size={16} />
            {tab === 'sources' ? '添加来源' : '添加模型'}
          </button>
        }
      />
      <div className="metric-strip">
        <div>
          <strong>{data?.providers.length ?? '—'}</strong>
          <span>模型来源</span>
        </div>
        <div>
          <strong>{data?.models.length ?? '—'}</strong>
          <span>白名单模型</span>
        </div>
        <div>
          <strong>{data?.models.filter((m) => m.enabled).length ?? '—'}</strong>
          <span>已启用</span>
        </div>
        <span className="admin-label">
          <ShieldCheck size={15} />
          仅管理员可见
        </span>
      </div>
      <div className="tabs">
        <button className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>
          模型来源 <span>{data?.providers.length ?? 0}</span>
        </button>
        <button className={tab === 'models' ? 'active' : ''} onClick={() => setTab('models')}>
          模型管理与授权 <span>{data?.models.length ?? 0}</span>
        </button>
      </div>
      <ErrorNote text={error || actionError} />
      {!data ? (
        !error && <Spinner />
      ) : tab === 'sources' ? (
        <>
          <div className="notice">
            <Radio size={17} />
            <span>
              支持 OpenAI 兼容接口。Base URL 请包含 API 前缀，例如{' '}
              <code>https://api.example.com/v1</code>。探测结果需要主动加入白名单才会启用。
            </span>
          </div>
          <div className="provider-grid">
            {data.providers.map((p) => (
              <section key={p.id} className="panel provider-card">
                <div className="row">
                  <span className="provider-icon">
                    <Server size={20} />
                  </span>
                  <div className="grow">
                    <h3>{p.name}</h3>
                    <span className="badge">
                      {p.apiMode === 'responses' ? 'Responses' : 'Chat Completions'}
                    </span>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`编辑 ${p.name}`}
                    onClick={() => {
                      setFormError('');
                      setTestResult('');
                      setProviderModal(p);
                    }}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`删除 ${p.name}`}
                    onClick={() =>
                      erase(
                        `/admin/providers/${p.id}`,
                        '删除此来源及其模型和授权？历史聊天和用量会保留。',
                      )
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <p className="provider-url">{p.baseUrl}</p>
                <div className="row provider-bottom">
                  <span className="muted small">{p.hasKey ? '密钥已加密保存' : '未配置密钥'}</span>
                  <button className="button" disabled={!!discovering} onClick={() => discover(p)}>
                    <RefreshCw size={14} className={discovering === p.id ? 'spin' : ''} />
                    {discovering === p.id ? '正在探测…' : '探测模型'}
                  </button>
                </div>
              </section>
            ))}
          </div>
          {!data.providers.length && (
            <Empty title="从连接第一个模型开始">
              添加云端服务或本地模型的 API 地址，然后选择要启用的模型。
            </Empty>
          )}
        </>
      ) : (
        <>
          <div className="notice">
            <ShieldCheck size={17} />
            <span>
              管理员可使用所有已启用模型；普通用户只可使用明确授权的模型。停用或撤销授权将在下一次请求生效。
            </span>
          </div>
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>模型 / 标识</th>
                  <th>来源</th>
                  <th>能力</th>
                  <th>授权用户</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.models.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.label}</strong>
                      <small>{m.name}</small>
                    </td>
                    <td>{m.providerName}</td>
                    <td>
                      <span className="badge">
                        {m.vision ? (
                          <>
                            <Eye size={12} />
                            文字 + 图片
                          </>
                        ) : (
                          '文字'
                        )}
                      </span>
                    </td>
                    <td>{m.userIds.length} 位用户</td>
                    <td>
                      <span className={`status ${m.enabled ? '' : 'off'}`}>
                        {m.enabled ? '已启用' : '已停用'}
                      </span>
                    </td>
                    <td>
                      <div className="row">
                        <button
                          className="button"
                          onClick={() => {
                            setFormError('');
                            setModelModal(m);
                          }}
                        >
                          管理
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`删除模型 ${m.label}`}
                          onClick={() =>
                            erase(
                              `/admin/models/${m.id}`,
                              '从白名单删除此模型？历史聊天和用量会保留。',
                            )
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.models.length && (
              <Empty title="白名单还是空的">从模型来源中探测模型，或使用右上角按钮手动添加。</Empty>
            )}
          </div>
        </>
      )}
      {providerModal && (
        <Modal
          title={providerModal === 'new' ? '添加模型来源' : '编辑模型来源'}
          close={() => !busy && !testing && setProviderModal(undefined)}
        >
          <form ref={providerForm} onSubmit={saveProvider} onChange={() => setTestResult('')}>
            <fieldset disabled={busy || testing}>
              <label>
                来源名称
                <input
                  name="name"
                  required
                  maxLength={60}
                  placeholder="例如：我的云端模型"
                  defaultValue={providerModal === 'new' ? '' : providerModal.name}
                />
              </label>
              <label>
                Base URL
                <input
                  name="baseUrl"
                  type="url"
                  required
                  placeholder="https://api.example.com/v1"
                  defaultValue={providerModal === 'new' ? '' : providerModal.baseUrl}
                />
              </label>
              <label>
                API Key
                <input
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    providerModal === 'new' ? '本地免鉴权服务可留空' : '留空保留已保存的密钥'
                  }
                />
              </label>
              <label>
                响应模式
                <select
                  name="apiMode"
                  defaultValue={
                    providerModal === 'new' ? 'chat-completions' : providerModal.apiMode
                  }
                >
                  <option value="chat-completions">Chat Completions · /chat/completions</option>
                  <option value="responses">Responses · /responses</option>
                </select>
              </label>
              <div className="connection-test">
                <label>
                  测试模型
                  <input
                    name="model"
                    placeholder="填写精确的模型名称"
                    defaultValue={
                      providerModal === 'new'
                        ? ''
                        : (data?.models.find((m) => m.providerId === providerModal.id)?.name ?? '')
                    }
                    maxLength={200}
                  />
                </label>
                <p className="muted small">
                  使用当前填写的配置发送简短请求，验证所选协议。会产生少量用量，计入当前管理员。
                </p>
                <button
                  type="button"
                  className="button"
                  disabled={testing || busy}
                  onClick={testConnection}
                >
                  <Radio size={15} />
                  {testing ? '正在测试…' : '测试连通性'}
                </button>
                {testResult && (
                  <p role="status" className="connection-success">
                    {testResult}
                  </p>
                )}
              </div>
              <ErrorNote text={formError} />
              <div className="modal-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => setProviderModal(undefined)}
                  disabled={busy}
                >
                  取消
                </button>
                <button className="button primary" disabled={busy || testing}>
                  {busy ? '保存中…' : '保存来源'}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
      {modelModal && data && (
        <Modal
          title={modelModal === 'new' ? '添加白名单模型' : '模型设置与授权'}
          close={() => !busy && setModelModal(undefined)}
        >
          <form onSubmit={saveModel}>
            {modelModal === 'new' && (
              <>
                <label>
                  模型来源
                  <select name="providerId" required>
                    {data.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  模型名称（API 标识）
                  <input
                    name="name"
                    required
                    maxLength={200}
                    placeholder="填写来源要求的精确模型名称"
                  />
                </label>
              </>
            )}
            <label>
              显示名称
              <input
                name="label"
                required
                maxLength={100}
                defaultValue={modelModal === 'new' ? '' : modelModal.label}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                name="vision"
                defaultChecked={modelModal !== 'new' && modelModal.vision}
              />
              支持图片输入
            </label>
            {modelModal !== 'new' && (
              <>
                <label className="check-row">
                  <input type="checkbox" name="enabled" defaultChecked={modelModal.enabled} />
                  启用此模型
                </label>
                <div className="divider" />
                <h3>用户授权</h3>
                <p className="small muted">所有管理员默认可用，普通用户需要逐一授权。</p>
                <div className="grant-list">
                  {data.users
                    .filter((u) => u.role === 'user')
                    .map((u) => (
                      <label key={u.id} className="check-row">
                        <input
                          type="checkbox"
                          name="userIds"
                          value={u.id}
                          defaultChecked={modelModal.userIds.includes(u.id)}
                        />
                        {u.displayName}
                        <span className="muted">
                          @{u.email ?? u.legacyUsername}
                          {!u.active && ' · 已停用'}
                        </span>
                      </label>
                    ))}
                  {!data.users.some((u) => u.role === 'user') && (
                    <p className="small muted">暂无普通用户，可在用户管理中创建。</p>
                  )}
                </div>
              </>
            )}
            <ErrorNote text={formError} />
            <div className="modal-actions">
              <button className="button primary" disabled={busy}>
                {busy ? '保存中…' : '保存模型'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {discovery && (
        <Modal
          title={`${discovery.provider.name} · 探测结果`}
          close={() => !busy && setDiscovery(undefined)}
        >
          <p className="muted small">
            发现 {discovery.names.length} 个模型。点击添加到白名单；图片能力需在模型管理中确认。
          </p>
          <ErrorNote text={formError} />
          <div className="discovery-list">
            {discovery.names.map((name) => {
              const added = data?.models.some(
                (m) => m.providerId === discovery.provider.id && m.name === name,
              );
              return (
                <div className="row" key={name}>
                  <code className="grow">{name}</code>
                  <button
                    className={`button ${added ? 'soft' : ''}`}
                    disabled={added || busy}
                    onClick={() => addDiscovered(name)}
                  >
                    {added ? (
                      <>
                        <Check size={14} />
                        已添加
                      </>
                    ) : (
                      <>
                        <Plus size={14} />
                        添加
                      </>
                    )}
                  </button>
                </div>
              );
            })}
            {!discovery.names.length && (
              <Empty title="来源没有返回模型">可以手动添加来源支持的模型名称。</Empty>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
