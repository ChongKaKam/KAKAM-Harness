import { useEffect, useState, useRef, type FormEvent } from 'react';
import {
  Plus,
  Radio,
  RefreshCw,
  Pencil,
  Trash2,
  Check,
  ShieldCheck,
  ExternalLink,
  Server,
} from 'lucide-react';
import { api, post, patch, remove } from '../../client/api';
import { useWorkspace } from '../../client/context';
import { PageHeader, Empty, ErrorNote, Modal, Spinner, useLoad } from '../../client/components';
import { apiModeLabels } from '../../shared/types';
import { SortableModels, type ManagedModel } from './sortable-models';
import { ModelConnectionProbe } from './model-connection-test';
import './models.css';
import type { Provider, User, Model } from '../../shared/types';
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
  useEffect(() => {
    if (tab !== 'sources') return;
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [tab]);
  const [providerModal, setProviderModal] = useState<Provider | 'new'>();
  const [modelModal, setModelModal] = useState<ManagedModel | 'new'>();
  const [discovery, setDiscovery] = useState<{
    provider: Pick<Provider, 'id' | 'name'>;
    names: string[];
  }>();
  const [discovering, setDiscovering] = useState('');
  const [discoveryKind, setDiscoveryKind] = useState<'llm' | 'embedding'>('llm');
  const providerForm = useRef<HTMLFormElement>(null);
  const [testing, setTesting] = useState(false);
  const [draftModels, setDraftModels] = useState<string[]>();
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');
  async function updated() {
    reload();
    await refresh();
  }
  async function saveProvider(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (probing) return;
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setFormError('');
    try {
      let id: string;
      if (providerModal === 'new') id = (await post<{ id: string }>('/admin/providers', values)).id;
      else {
        id = providerModal!.id;
        await patch(`/admin/providers/${providerModal!.id}`, {
          ...values,
          apiKey: values.apiKey || undefined,
        });
      }
      const detected = draftModels;
      setProviderModal(undefined);
      await updated();
      notify('模型来源已保存');
      if (detected?.length)
        setDiscovery({ provider: { id, name: String(values.name).trim() }, names: detected });
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function discoverDraft() {
    const form = providerForm.current;
    if (!form?.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    setProbing(true);
    setFormError('');
    setDraftModels(undefined);
    try {
      const result = await post<{ models: string[] }>('/admin/providers/discover', {
        baseUrl: values.baseUrl,
        apiMode: values.apiMode,
        id: providerModal !== 'new' ? providerModal?.id : undefined,
        apiKey: providerModal === 'new' ? values.apiKey : values.apiKey || undefined,
      });
      setDraftModels(result.models);
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setProbing(false);
    }
  }
  async function saveModel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (testing) return;
    const form = new FormData(e.currentTarget);
    const values = Object.fromEntries(form);
    setBusy(true);
    setFormError('');
    try {
      if (modelModal === 'new')
        await post('/admin/models', {
          ...values,
          embeddingDimensions: values.embeddingDimensions
            ? Number(values.embeddingDimensions)
            : null,
          vision: form.has('vision'),
          toolCalling: form.has('toolCalling'),
        });
      else
        await patch(`/admin/models/${modelModal!.id}`, {
          label: values.label,
          kind: values.kind,
          embeddingDimensions: values.embeddingDimensions
            ? Number(values.embeddingDimensions)
            : null,
          vision: form.has('vision'),
          toolCalling: form.has('toolCalling'),
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
    setFormError('');
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
        ...(data?.providers.find((p) => p.id === discovery!.provider.id)?.apiMode !== 'jev'
          ? {
              kind: ['chat-completions', 'responses'].includes(
                data!.providers.find((p) => p.id === discovery!.provider.id)!.apiMode,
              )
                ? discoveryKind
                : 'llm',
            }
          : {}),
      });
      await updated();
      notify('已加入白名单，可在模型管理中配置能力、维度和用户授权');
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
                setDraftModels(undefined);
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
              支持 OpenAI 兼容接口、Anthropic Messages 与 Jev 决策协议。Base URL 请包含 API
              前缀，例如 <code>https://api.example.com/v1</code>
              。OpenAI 兼容来源也支持 Embedding。探测结果需要主动加入白名单才会启用。
            </span>
          </div>
          <div className="models-provider-list">
            {data.providers.map((p) => (
              <section key={p.id} className="panel provider-card models-provider-card">
                <span className="provider-icon">
                  <Server size={18} />
                </span>
                <div className="models-provider-info">
                  <div className="models-provider-title">
                    <h3>{p.name}</h3>
                    <span className="badge">{apiModeLabels[p.apiMode]}</span>
                    <span
                      className={`models-provider-health is-${p.health.state}`}
                      title={
                        p.health.checkedAt
                          ? `模型列表接口上次检查：${new Date(p.health.checkedAt).toLocaleString()}`
                          : '尚未完成检查'
                      }
                    >
                      <span className="models-provider-health-light" aria-hidden="true" />
                      {p.health.state === 'ok'
                        ? '模型列表正常'
                        : p.health.state === 'error'
                          ? '模型列表异常'
                          : p.health.state === 'checking'
                            ? '检查中'
                            : '待检查'}
                    </span>
                  </div>
                  <p className="models-provider-url">{p.baseUrl}</p>
                  <div className="models-provider-meta small muted">
                    <span>
                      {data.models.filter((m) => m.providerId === p.id).length} 个白名单模型
                    </span>
                    <span>{p.hasKey ? '密钥已加密保存' : '未配置密钥'}</span>
                    {p.platformUrl && (
                      <a
                        className="models-platform-link"
                        href={p.platformUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        访问平台 <ExternalLink size={13} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </div>
                <div className="models-provider-actions">
                  <button className="button" disabled={!!discovering} onClick={() => discover(p)}>
                    <RefreshCw size={14} className={discovering === p.id ? 'spin' : ''} />
                    {discovering === p.id ? '正在探测…' : '探测模型'}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`编辑 ${p.name}`}
                    onClick={() => {
                      setFormError('');
                      setDraftModels(undefined);
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
          <SortableModels
            models={data.models}
            onOrder={async (modelIds) => {
              setActionError('');
              try {
                await patch('/admin/models/order', { modelIds });
                await updated();
                notify('模型顺序已保存');
              } catch (error) {
                setActionError((error as Error).message);
                reload();
                throw error;
              }
            }}
            onEdit={(model) => {
              setFormError('');
              setModelModal(model);
            }}
            onDelete={(model) => {
              void erase(`/admin/models/${model.id}`, '从白名单删除此模型？历史聊天和用量会保留。');
            }}
          />
        </>
      )}
      {providerModal && (
        <Modal
          title={providerModal === 'new' ? '添加模型来源' : '编辑模型来源'}
          close={() => !busy && !probing && setProviderModal(undefined)}
        >
          <form
            ref={providerForm}
            onSubmit={saveProvider}
            onChange={(event) => {
              const target = event.target;
              if (
                (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) &&
                ['baseUrl', 'apiKey', 'apiMode'].includes(target.name)
              )
                setDraftModels(undefined);
              setFormError('');
            }}
          >
            <fieldset disabled={busy || probing}>
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
                平台链接（可选）
                <input
                  name="platformUrl"
                  type="url"
                  maxLength={2048}
                  placeholder="https://console.example.com"
                  defaultValue={providerModal === 'new' ? '' : (providerModal.platformUrl ?? '')}
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
                  <option value="jev">Jev 决策 · /systemone</option>
                  <option value="responses">Responses · /responses</option>
                  <option value="anthropic-messages">Anthropic Messages · /messages</option>
                </select>
              </label>
              <p className="small muted">
                Jev 来源使用 https://api.typesafe.ai/v1，模型会自动归类为决策模型，不用于聊天回复。
              </p>
              <section className="models-probe" aria-label="模型探测">
                <h3>模型探测</h3>
                <p className="muted small">
                  使用当前填写的配置获取模型列表，不发送聊天请求。保存来源后可选择加入白名单。
                </p>
                <button
                  type="button"
                  className="button"
                  disabled={probing || busy}
                  onClick={discoverDraft}
                >
                  <RefreshCw size={15} className={probing ? 'spin' : ''} />
                  {probing ? '正在探测…' : '探测模型'}
                </button>
                {draftModels && (
                  <>
                    <p role="status" className="small">
                      发现 {draftModels.length} 个模型
                      {draftModels.length
                        ? '，保存后可添加到白名单。'
                        : '，也可以保存来源后手动添加模型。'}
                    </p>
                    {!!draftModels.length && (
                      <ul className="models-discovery-preview" aria-label="探测到的模型">
                        {draftModels.map((name) => (
                          <li key={name}>
                            <code>{name}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>
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
                <button className="button primary" disabled={busy || probing}>
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
          close={() => !busy && !testing && setModelModal(undefined)}
        >
          <form onSubmit={saveModel}>
            <fieldset disabled={busy || testing}>
              <ModelConfigurationFields
                key={modelModal === 'new' ? 'new' : modelModal.id}
                model={modelModal}
                providers={data.providers}
              />
              <label>
                显示名称
                <input
                  name="label"
                  required
                  maxLength={100}
                  defaultValue={modelModal === 'new' ? '' : modelModal.label}
                />
              </label>
              {modelModal !== 'new' && (
                <>
                  <label className="check-row">
                    <input type="checkbox" name="enabled" defaultChecked={modelModal.enabled} />
                    启用此模型
                  </label>
                  <ModelConnectionProbe
                    key={modelModal.id}
                    modelId={modelModal.id}
                    modelName={modelModal.name}
                    apiMode={data.providers.find((p) => p.id === modelModal.providerId)!.apiMode}
                    kind={modelModal.kind}
                    busy={busy}
                    onTesting={setTesting}
                    onResult={(result) => {
                      reload();
                      if (result.kind === 'embedding' && result.ok)
                        setModelModal((previous) =>
                          previous && previous !== 'new' && previous.id === modelModal.id
                            ? { ...previous, validatedDimensions: result.actualDimensions ?? null }
                            : previous,
                        );
                    }}
                  />
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
            </fieldset>
          </form>
        </Modal>
      )}
      {discovery && (
        <Modal
          title={`${discovery.provider.name} · 探测结果`}
          close={() => !busy && setDiscovery(undefined)}
        >
          <p className="muted small">
            发现 {discovery.names.length}{' '}
            个模型。选择模型类型后添加到白名单，可继续管理能力和用户授权。
          </p>
          {['chat-completions', 'responses'].includes(
            data?.providers.find((p) => p.id === discovery.provider.id)?.apiMode ??
              'anthropic-messages',
          ) && (
            <label>
              添加模型类型
              <select
                value={discoveryKind}
                onChange={(event) => setDiscoveryKind(event.target.value as 'llm' | 'embedding')}
                disabled={busy}
              >
                <option value="llm">LLM · 对话模型</option>
                <option value="embedding">Embedding · 向量模型</option>
              </select>
            </label>
          )}
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
function ModelConfigurationFields({
  model,
  providers,
}: {
  model: ManagedModel | 'new';
  providers: Provider[];
}) {
  const [providerId, setProviderId] = useState(
    model === 'new' ? providers[0]?.id : model.providerId,
  );
  const provider = providers.find((item) => item.id === providerId);
  const [kind, setKind] = useState<Model['kind']>(
    model === 'new' ? (provider?.apiMode === 'jev' ? 'jev' : 'llm') : model.kind,
  );
  const supportsEmbedding =
    provider && ['chat-completions', 'responses'].includes(provider.apiMode);
  return (
    <>
      {model === 'new' && (
        <>
          <label>
            模型来源
            <select
              name="providerId"
              required
              value={providerId}
              onChange={(event) => {
                const next = providers.find((item) => item.id === event.target.value)!;
                setProviderId(next.id);
                setKind(
                  next.apiMode === 'jev'
                    ? 'jev'
                    : kind === 'embedding' &&
                        ['chat-completions', 'responses'].includes(next.apiMode)
                      ? 'embedding'
                      : 'llm',
                );
              }}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {apiModeLabels[item.apiMode]}
                </option>
              ))}
            </select>
          </label>
          <label>
            模型名称（API 标识）
            <input name="name" required maxLength={200} placeholder="填写来源要求的精确模型名称" />
          </label>
        </>
      )}
      <label>
        模型类型
        <select
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as Model['kind'])}
        >
          {provider?.apiMode === 'jev' ? (
            <option value="jev">Jev · 决策模型</option>
          ) : (
            <>
              <option value="llm">LLM · 对话模型</option>
              {supportsEmbedding && <option value="embedding">Embedding · 向量模型</option>}
            </>
          )}
        </select>
      </label>
      {kind === 'embedding' && (
        <>
          <label>
            配置维度
            <input
              name="embeddingDimensions"
              type="number"
              min={1}
              max={16000}
              step={1}
              placeholder="自动 · 使用上游默认维度"
              defaultValue={model === 'new' ? '' : (model.embeddingDimensions ?? '')}
            />
          </label>
          <p className="small muted">
            仅在模型支持时指定维度；更改后需要重建记忆向量空间。最近验证维度：
            {model === 'new' ? '未验证' : (model.validatedDimensions ?? '未验证')}。
          </p>
        </>
      )}
      {kind === 'llm' && (
        <>
          <label className="check-row">
            <input type="checkbox" name="vision" defaultChecked={model !== 'new' && model.vision} />
            支持图片输入
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              name="toolCalling"
              defaultChecked={model !== 'new' && model.toolCalling}
            />
            支持工具调用（Skill 参考文档按需读取）
          </label>
        </>
      )}
    </>
  );
}
