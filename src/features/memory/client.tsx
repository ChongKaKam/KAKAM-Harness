import { useEffect, useId, useState } from 'react';
import { Brain, Check, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api, patch, post, remove } from '../../client/api';
import { Empty, ErrorNote, Modal, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { ConversationGroup, Model } from '../../shared/types';
import type {
  MemoryItem,
  MemoryKind,
  MemoryOperation,
  MemoryPreferences,
  MemoryProposal,
  MemoryScope,
  MemoryStatus,
  MemoryStrategyInfo,
} from '../../shared/memory';
import { MemorySettings } from './settings';
import './memory.css';

export const scopeLabels: Record<MemoryScope, string> = {
  user: '长期记忆',
  group: '分组记忆',
  session: 'Session 记忆',
};
export const kindLabels: Record<MemoryKind, string> = {
  profile: '画像',
  preference: '偏好',
  instruction: '指令',
  fact: '事实',
  episode: '经历',
  summary: '摘要',
  task: '任务',
};
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function MemoryPage() {
  const { user } = useWorkspace();
  return <MemoryPageContent key={user.id} />;
}
function MemoryPageContent() {
  const { data: status, error, reload } = useLoad(() => api<MemoryStatus>('/memory/v1/status'));
  return (
    <div className="page memory-page">
      <PageHeader
        eyebrow="MEMORY MANAGER"
        title="记忆管理"
        description="管理长期、分组与 Session 记忆，为每轮对话选择相关上下文。"
        action={
          <button type="button" className="button" onClick={reload}>
            <RefreshCw size={16} />
            刷新状态
          </button>
        }
      />
      <ErrorNote text={error} />
      {!status && !error && <Spinner />}
      {status && (
        <>
          <div className="memory-service-state" role="status">
            <Brain size={18} aria-hidden="true" />
            <span>
              {status.ready
                ? 'PostgreSQL / pgvector 已连接'
                : status.configured
                  ? '记忆数据库暂不可用'
                  : '记忆数据库尚未配置'}
            </span>
          </div>
          {!status.ready && (
            <div className="notice">
              {status.error ||
                '请由管理员配置独立的 PostgreSQL 记忆数据库与 pgvector 扩展，然后刷新。配置完成前，聊天仍可继续。'}
            </div>
          )}
          {status.ready && <MemoryWorkspace status={status} reloadStatus={reload} />}
        </>
      )}
    </div>
  );
}
function MemoryWorkspace({ status, reloadStatus }: { status: MemoryStatus; reloadStatus(): void }) {
  const { user } = useWorkspace();
  const [tab, setTab] = useState<'settings' | 'memories' | 'proposals' | 'indexes'>('settings');
  const tabs = [
    { id: 'settings', label: '设置与策略' },
    { id: 'memories', label: '已保存记忆' },
    { id: 'proposals', label: '待确认候选' },
    { id: 'indexes', label: '索引与任务' },
  ] as const;
  const id = useId();
  const { data, error, reload } = useLoad(async () => {
    const [preferences, strategies, models, groups] = await Promise.all([
      api<MemoryPreferences>('/memory/v1/preferences'),
      api<MemoryStrategyInfo[]>('/memory/v1/strategies'),
      api<Model[]>('/models?kind=all'),
      api<ConversationGroup[]>('/conversation-groups'),
    ]);
    return { preferences, strategies, models, groups };
  }, [user.id]);
  return (
    <>
      <div className="tabs memory-tabs" role="tablist" aria-label="记忆管理分区">
        {tabs.map((item, index) => (
          <button
            type="button"
            key={item.id}
            id={`${id}-${item.id}-tab`}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`${id}-panel`}
            tabIndex={tab === item.id ? 0 : -1}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
              setTab(tabs[next].id);
              document.getElementById(`${id}-${tabs[next].id}-tab`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <ErrorNote text={error} />
      {!data && !error && <Spinner />}
      {data && (
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}-tab`}>
          {tab === 'settings' && (
            <MemorySettings
              key={JSON.stringify(data.preferences)}
              initial={data.preferences}
              models={data.models}
              strategies={data.strategies}
              saved={() => {
                reload();
                reloadStatus();
              }}
            />
          )}
          {tab === 'memories' && <MemoryLibrary groups={data.groups} />}
          {tab === 'proposals' && <MemoryProposals />}
          {tab === 'indexes' && (
            <MemoryIndexes status={status} models={data.models} reloadStatus={reloadStatus} />
          )}
        </div>
      )}
    </>
  );
}

function MemoryLibrary({ groups }: { groups: ConversationGroup[] }) {
  const { conversations } = useWorkspace();
  const [scope, setScope] = useState<MemoryScope | ''>('');
  const [scopeId, setScopeId] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<MemoryItem | 'new'>();
  const [deletion, setDeletion] = useState<MemoryItem>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const filters = new URLSearchParams();
  if (scope) filters.set('scope', scope);
  if (scopeId) filters.set('scopeId', scopeId);
  if (search) filters.set('query', search);
  const { data, error, reload } = useLoad(
    () => api<MemoryItem[]>(`/memory/v1/memories?${filters}`),
    [scope, scopeId, search],
  );
  useEffect(() => {
    if (!data?.some((item) => item.indexStatus === 'pending')) return;
    const timer = window.setTimeout(reload, 3000);
    return () => window.clearTimeout(timer);
  }, [data]);
  return (
    <>
      <div className="memory-toolbar">
        <label>
          搜索记忆
          <input
            type="search"
            value={query}
            maxLength={200}
            placeholder="正文或标签"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          记忆范围
          <select
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as MemoryScope | '');
              setScopeId('');
            }}
          >
            <option value="">全部范围</option>
            {Object.entries(scopeLabels).map(([key, value]) => (
              <option value={key} key={key}>
                {value}
              </option>
            ))}
          </select>
        </label>
        {scope === 'group' && (
          <label>
            分组
            <select value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
              <option value="">全部分组</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {scope === 'session' && (
          <label>
            对话
            <select value={scopeId} onChange={(event) => setScopeId(event.target.value)}>
              <option value="">全部对话</option>
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="button" className="button primary" onClick={() => setEditor('new')}>
          <Plus size={16} />
          添加记忆
        </button>
        <button type="button" className="button" onClick={reload}>
          刷新记忆
        </button>
      </div>
      <ErrorNote text={error || actionError} />
      {!data && !error && <Spinner />}
      {data && !data.length && (
        <Empty title={search || scope ? '没有匹配的记忆' : '还没有保存记忆'}>
          手动添加记忆，或在设置中开启对话抽取。
        </Empty>
      )}
      <div className="memory-list">
        {data?.map((item) => (
          <article key={item.id} className="memory-item">
            <div className="memory-item-heading">
              <div className="memory-meta">
                <strong>{scopeLabels[item.scope]}</strong>
                <span>{kindLabels[item.kind]}</span>
                <span>v{item.version}</span>
                {item.pinned && <span>置顶</span>}
                <span>
                  {
                    { active: '有效', review: '待复核', deleted: '已删除', superseded: '已替代' }[
                      item.status
                    ]
                  }
                </span>
              </div>
              <div className="memory-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label="编辑记忆"
                  onClick={() => setEditor(item)}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="删除记忆"
                  onClick={() => setDeletion(item)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <p className="memory-content">{item.content}</p>
            {item.tags.length > 0 && (
              <div className="memory-tags">
                {item.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            )}
            <p className="memory-caption">
              {date(item.updatedAt)} ·{' '}
              {item.expiresAt ? `到期 ${date(item.expiresAt)}` : '长期保留'}
              {item.indexStatus &&
                ` · 索引${{ pending: '待处理', ready: '已就绪', error: '失败' }[item.indexStatus]}`}
              {item.scopeId &&
                ` · ${groups.find((group) => group.id === item.scopeId)?.name ?? conversations.find((conversation) => conversation.id === item.scopeId)?.title ?? item.scopeId.slice(0, 8)}`}
            </p>
            {!!item.sources.length && (
              <details className="memory-sources">
                <summary>来源与证据 · {item.sources.length}</summary>
                {item.sources.map((source, index) => (
                  <p key={index} className="memory-caption">
                    对话 {source.conversationId.slice(0, 8)} · 消息 {source.messageId.slice(0, 8)}
                    {source.evidence && ` · ${source.evidence}`}
                  </p>
                ))}
              </details>
            )}
          </article>
        ))}
      </div>
      {editor && (
        <MemoryEditor
          item={editor}
          initialScope={scope || 'user'}
          initialScopeId={scopeId}
          groups={groups}
          close={() => setEditor(undefined)}
          saved={() => {
            setEditor(undefined);
            reload();
          }}
        />
      )}
      {deletion && (
        <Modal
          title="删除记忆"
          close={() => {
            if (!busy) setDeletion(undefined);
          }}
        >
          <p className="memory-caption">
            删除后会清理正文、向量与历史副本，并移除上下文快照中的记忆正文。原聊天记录继续保留。
          </p>
          <p className="memory-content">{deletion.content}</p>
          <ErrorNote text={actionError} />
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setDeletion(undefined)}
            >
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setActionError('');
                try {
                  await remove(`/memory/v1/memories/${deletion.id}`);
                  setDeletion(undefined);
                  reload();
                } catch (error) {
                  setActionError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '删除中…' : '删除记忆'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function MemoryEditor({
  item,
  initialScope,
  initialScopeId,
  groups,
  close,
  saved,
}: {
  item: MemoryItem | 'new';
  initialScope: MemoryScope;
  initialScopeId: string;
  groups: ConversationGroup[];
  close(): void;
  saved(): void;
}) {
  const { conversations } = useWorkspace();
  const existing = item === 'new' ? undefined : item;
  const [scope, setScope] = useState(existing?.scope ?? initialScope);
  const [scopeId, setScopeId] = useState(existing?.scopeId ?? initialScopeId);
  const [kind, setKind] = useState<MemoryKind>(existing?.kind ?? 'fact');
  const [content, setContent] = useState(existing?.content ?? '');
  const [tags, setTags] = useState(existing?.tags.join(', ') ?? '');
  const [pinned, setPinned] = useState(existing?.pinned ?? false);
  const [expiresAt, setExpiresAt] = useState(existing?.expiresAt ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      title={existing ? '编辑记忆' : '添加记忆'}
      className="memory-editor"
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const values = {
              kind,
              content,
              tags: [
                ...new Set(
                  tags
                    .split(/[,，\n]/)
                    .map((tag) => tag.trim())
                    .filter(Boolean),
                ),
              ],
              pinned,
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            };
            if (existing)
              await patch(`/memory/v1/memories/${existing.id}`, {
                ...values,
                version: existing.version,
              });
            else
              await post('/memory/v1/memories', {
                ...values,
                scope,
                scopeId: scope === 'user' ? null : scopeId,
              });
            saved();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="memory-editor-fields">
          <div className="memory-form-grid">
            <label>
              记忆范围
              <select
                value={scope}
                disabled={!!existing}
                onChange={(event) => {
                  setScope(event.target.value as MemoryScope);
                  setScopeId('');
                }}
              >
                {Object.entries(scopeLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              内容分类
              <select value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
                {Object.entries(kindLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {scope !== 'user' && (
              <label>
                {scope === 'group' ? '所属分组' : '所属对话'}
                <select
                  value={scopeId}
                  disabled={!!existing}
                  required
                  onChange={(event) => setScopeId(event.target.value)}
                >
                  <option value="">选择范围</option>
                  {(scope === 'group'
                    ? groups.map((group) => ({ id: group.id, label: group.name }))
                    : conversations.map((conversation) => ({
                        id: conversation.id,
                        label: conversation.title,
                      }))
                  ).map((entry) => (
                    <option value={entry.id} key={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label>
            记忆正文
            <textarea
              required
              rows={8}
              maxLength={8000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <label>
            标签（逗号分隔）
            <input
              value={tags}
              maxLength={1000}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <label>
            到期时间（留空则长期保留）
            <input
              type="datetime-local"
              value={expiresAt ? localDate(expiresAt) : ''}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <label className="memory-check">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(event) => setPinned(event.target.checked)}
            />
            优先召回
          </label>
        </fieldset>
        <ErrorNote text={error} />
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !content.trim() || (scope !== 'user' && !scopeId)}
          >
            {busy ? '保存中…' : '保存记忆'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function localDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export function MemoryProposals({
  conversationId,
  messageId,
  compact = false,
}: {
  conversationId?: string;
  messageId?: string;
  compact?: boolean;
}) {
  const { data, error, reload } = useLoad(() => {
    const query = new URLSearchParams();
    if (conversationId) query.set('conversationId', conversationId);
    if (messageId) query.set('messageId', messageId);
    return api<MemoryProposal[]>(`/memory/v1/proposals?${query}`);
  }, [conversationId, messageId]);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  return (
    <section className={compact ? 'memory-proposals memory-proposals-compact' : 'memory-proposals'}>
      <div className="memory-item-heading">
        <h3>{compact ? '回答后的抽取候选' : '待确认记忆'}</h3>
        <button type="button" className="button" onClick={reload}>
          <RefreshCw size={15} />
          刷新候选
        </button>
      </div>
      <p className="memory-caption">
        {compact
          ? '这些候选在回答完成后产生，不属于本轮已发送上下文。'
          : '确认后成为可召回记忆；拒绝不会修改原聊天。候选必须由用户确认，模型不能自行批准。'}
      </p>
      <ErrorNote text={error || actionError} />
      {!data && !error && <Spinner />}
      {data && !data.length && <p className="memory-caption">暂无待确认候选。</p>}
      <div className="memory-list">
        {data?.map((proposal) => (
          <article className="memory-item" key={proposal.id}>
            <div className="memory-meta">
              <strong>{scopeLabels[proposal.scope]}</strong>
              <span>{kindLabels[proposal.kind]}</span>
              <span>{date(proposal.createdAt)}</span>
            </div>
            <p className="memory-content">{proposal.content}</p>
            {proposal.sources.map(
              (source, index) =>
                source.evidence && (
                  <p className="memory-caption" key={index}>
                    用户证据：{source.evidence}
                  </p>
                ),
            )}
            <div className="memory-actions">
              {(['approve', 'reject'] as const).map((decision) => (
                <button
                  type="button"
                  className={decision === 'approve' ? 'button primary' : 'button'}
                  key={decision}
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(proposal.id);
                    setActionError('');
                    try {
                      await post(`/memory/v1/proposals/${proposal.id}/decision`, { decision });
                      reload();
                    } catch (error) {
                      setActionError((error as Error).message);
                    } finally {
                      setBusy('');
                    }
                  }}
                >
                  {decision === 'approve' ? <Check size={15} /> : <X size={15} />}
                  {busy === proposal.id ? '处理中…' : decision === 'approve' ? '确认保存' : '拒绝'}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function MemoryIndexes({
  status,
  models,
  reloadStatus,
}: {
  status: MemoryStatus;
  models: Model[];
  reloadStatus(): void;
}) {
  const {
    data: operations,
    error,
    reload,
  } = useLoad(() => api<MemoryOperation[]>('/memory/v1/operations'));
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    if (
      !status.spaces.some((space) => space.state === 'building') &&
      !operations?.some((operation) => operation.state === 'running')
    )
      return;
    const timer = window.setTimeout(() => {
      reload();
      reloadStatus();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [status.spaces, operations]);
  async function action(path: string) {
    setBusy(path);
    setActionError('');
    try {
      await post(path);
      reload();
      reloadStatus();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="memory-indexes">
      <div className="memory-item-heading">
        <h2>向量空间</h2>
        <button
          type="button"
          className="button primary"
          disabled={!!busy}
          onClick={() => void action('/memory/v1/indexes/rebuild')}
        >
          <RefreshCw size={16} />
          {busy === '/memory/v1/indexes/rebuild' ? '启动中…' : '重建当前模型索引'}
        </button>
      </div>
      <p className="memory-caption">
        重建会调用已选择的 embedding
        模型并计入实际用量。不同模型、维度与配置使用独立向量空间；就绪前不会混用旧向量。
      </p>
      <ErrorNote text={error || actionError} />
      {!status.spaces.length && (
        <p className="memory-caption">尚未建立向量空间。保存 embedding 模型设置后，可重建索引。</p>
      )}
      <div className="memory-list">
        {status.spaces.map((space) => (
          <article key={space.id} className="memory-item">
            <div className="memory-meta">
              <strong>
                {models.find((model) => model.id === space.modelId)?.label ?? '原模型不可用'}
              </strong>
              <span>{space.dimensions} 维</span>
              <span>
                {
                  { building: '重建中', active: '已启用', retired: '已停用', error: '失败' }[
                    space.state
                  ]
                }
              </span>
            </div>
            <p className="memory-caption">
              空间 {space.id.slice(0, 8)} · {date(space.createdAt)}
              {space.indexed !== undefined &&
                ` · 已索引 ${space.indexed} / ${space.total ?? '未知'}`}
            </p>
          </article>
        ))}
      </div>
      <div className="memory-item-heading">
        <h2>最近任务</h2>
        <button
          type="button"
          className="button"
          onClick={() => {
            reload();
            reloadStatus();
          }}
        >
          刷新任务
        </button>
      </div>
      {!operations && !error && <Spinner />}
      {operations && !operations.length && <p className="memory-caption">暂无任务记录。</p>}
      <div className="memory-list">
        {operations?.map((operation) => (
          <article key={operation.id} className="memory-item">
            <div className="memory-meta">
              <strong>
                {{ recall: '召回', extract: '抽取', rebuild: '索引重建', index: '索引' }[
                  operation.type
                ] ?? operation.type}
              </strong>
              <span>
                {
                  {
                    running: '运行中',
                    prepared: '已准备',
                    applied: '已注入',
                    complete: '已完成',
                    error: '失败',
                    cancelled: '已取消',
                  }[operation.state]
                }
              </span>
              <span>{date(operation.createdAt)}</span>
            </div>
            <OperationProgress operation={operation} />
            <ErrorNote text={operation.error ?? ''} />
            <div className="memory-actions">
              {(operation.state === 'error' || operation.state === 'cancelled') && (
                <button
                  type="button"
                  className="button"
                  disabled={!!busy}
                  onClick={() => void action(`/memory/v1/operations/${operation.id}/retry`)}
                >
                  重试任务
                </button>
              )}
              {operation.state === 'running' && (
                <button
                  type="button"
                  className="button"
                  disabled={!!busy}
                  onClick={() => void action(`/memory/v1/operations/${operation.id}/cancel`)}
                >
                  取消任务
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
export function OperationProgress({ operation }: { operation: MemoryOperation }) {
  const indexed = operation.facts.indexed ?? operation.facts.completed;
  const total = operation.facts.total;
  return typeof indexed === 'number' ? (
    <p className="memory-caption" role="status">
      已处理 {indexed}
      {typeof total === 'number' ? ` / ${total}` : ''}
    </p>
  ) : null;
}
