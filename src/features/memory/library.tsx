import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, patch, post, remove } from '../../client/api';
import { Empty, ErrorNote, Modal, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { ConversationGroup } from '../../shared/types';
import type { MemoryItem, MemoryKind, MemoryScope } from '../../shared/memory';
import { kindLabels, scopeLabels, memoryDate as date } from './labels';
import { MemorySources } from './sources';

type LibraryStatus = '' | 'active' | 'pending' | 'review';
export function MemoryLibrary({
  groups,
  pendingOnly = false,
}: {
  groups: ConversationGroup[];
  pendingOnly?: boolean;
}) {
  const { conversations } = useWorkspace();
  const [scope, setScope] = useState<MemoryScope | ''>(pendingOnly ? 'user' : '');
  const [scopeId, setScopeId] = useState('');
  const [status, setStatus] = useState<LibraryStatus>(pendingOnly ? 'pending' : '');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<MemoryItem | 'new'>();
  const [deletion, setDeletion] = useState<MemoryItem>();
  const [admission, setAdmission] = useState<{
    item: MemoryItem;
    decision: 'include' | 'withdraw';
  }>();
  const [sourceItem, setSourceItem] = useState<MemoryItem>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const filters = new URLSearchParams();
  if (scope) filters.set('scope', scope);
  if (scopeId) filters.set('scopeId', scopeId);
  if (status) filters.set('status', status);
  if (search) filters.set('query', search);
  const { data, error, reload } = useLoad(
    () => api<MemoryItem[]>(`/memory/v1/memories?${filters}`),
    [scope, scopeId, status, search],
  );
  useEffect(() => {
    if (!data?.some((item) => item.status === 'active' && item.indexStatus === 'pending')) return;
    const timer = window.setTimeout(reload, 3000);
    return () => window.clearTimeout(timer);
  }, [data]);
  return (
    <>
      <div className={`memory-toolbar ${pendingOnly ? 'memory-toolbar-pending' : ''}`}>
        <label className="memory-search-field">
          搜索记忆
          <input
            type="search"
            value={query}
            maxLength={200}
            placeholder="正文或标签"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {!pendingOnly && (
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
        )}
        {!pendingOnly && (
          <label>
            记忆状态
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as LibraryStatus)}
            >
              <option value="">全部状态</option>
              <option value="active">已纳入 / 有效</option>
              <option value="pending">待纳入</option>
              <option value="review">待复核</option>
            </select>
          </label>
        )}
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
        <div className="memory-toolbar-actions">
          <button type="button" className="button primary" onClick={() => setEditor('new')}>
            <Plus size={16} />
            添加记忆
          </button>
          <button type="button" className="button" onClick={reload}>
            刷新记忆
          </button>
        </div>
      </div>
      <ErrorNote text={error || actionError} />
      {!data && !error && <Spinner />}
      {data && !data.length && (
        <Empty
          title={
            pendingOnly
              ? '暂无待纳入长期记忆'
              : search || scope || status
                ? '没有匹配的记忆'
                : '还没有保存记忆'
          }
        >
          {pendingOnly
            ? 'Remember it 或自动抽取产生的长期记忆会在此等待你的确认。'
            : '手动添加记忆，或在策略设置中开启对话抽取。'}
        </Empty>
      )}
      {data && data.length > 0 && (
        <p className="memory-caption" role="status">
          显示 {data.length} 条记忆{status === 'pending' ? ' · 待纳入内容不会召回' : ''}
        </p>
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
                    {
                      active: item.scope === 'user' ? '已纳入' : '有效',
                      pending: '待纳入',
                      review: '待复核',
                      deleted: '已删除',
                      superseded: '已替代',
                    }[item.status]
                  }
                </span>
              </div>
              <div className="memory-actions">
                <button
                  className="icon-button"
                  type="button"
                  aria-label="编辑记忆"
                  onClick={() => {
                    setActionError('');
                    setEditor(item);
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="删除记忆"
                  onClick={() => {
                    setActionError('');
                    setDeletion(item);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <p className="memory-content">{item.content}</p>
            {item.tags.length > 0 && (
              <div className="memory-tags">
                {item.tags.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    onClick={() => setQuery(tag)}
                    aria-label={`搜索标签 ${tag}`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
            <p className="memory-caption">
              {date(item.updatedAt)} ·{' '}
              {item.expiresAt ? `到期 ${date(item.expiresAt)}` : '长期保留'}
              {item.status === 'active' &&
                item.indexStatus &&
                ` · 索引${{ pending: '待处理', ready: '已就绪', error: '失败' }[item.indexStatus]}`}
              {item.scopeId &&
                ` · ${groups.find((group) => group.id === item.scopeId)?.name ?? conversations.find((conversation) => conversation.id === item.scopeId)?.title ?? item.scopeId.slice(0, 8)}`}
            </p>
            {item.scope === 'user' && (
              <p className="memory-caption memory-admission-state">
                {item.status === 'active'
                  ? item.admittedAt
                    ? `纳入时间 · ${date(item.admittedAt)}`
                    : '历史纳入（时间未记录）'
                  : item.status === 'pending'
                    ? '未纳入长期记忆 · 不参与全局召回'
                    : '需要复核正文与来源，当前不参与召回'}
              </p>
            )}
            <div className="memory-item-footer">
              {!!item.sources.length && (
                <button
                  type="button"
                  className="button memory-source-button"
                  onClick={() => setSourceItem(item)}
                >
                  来源与原文 · {item.sources.length}
                </button>
              )}
              {!item.sources.length && (
                <span className="memory-caption">手动录入 · 无聊天来源</span>
              )}
              {item.scope === 'user' && (item.status === 'pending' || item.status === 'active') && (
                <button
                  type="button"
                  className={item.status === 'pending' ? 'button primary' : 'button'}
                  onClick={() => {
                    setActionError('');
                    setAdmission({
                      item,
                      decision: item.status === 'pending' ? 'include' : 'withdraw',
                    });
                  }}
                >
                  {item.status === 'pending' ? <Check size={15} /> : null}
                  {item.status === 'pending' ? '审核并纳入' : '撤回纳入'}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {sourceItem && <MemorySources item={sourceItem} close={() => setSourceItem(undefined)} />}
      {admission && (
        <Modal
          title={admission.decision === 'include' ? '确认纳入长期记忆' : '撤回长期记忆'}
          className="memory-editor"
          close={() => {
            if (!busy) setAdmission(undefined);
          }}
        >
          <p className="memory-caption">
            {admission.decision === 'include'
              ? '请核对以下内容。纳入后可在你的全部对话中召回，并记录本次纳入时间。'
              : '撤回后正文仍保留为待纳入状态，后续对话不会召回。'}
          </p>
          <p className="memory-content">{admission.item.content}</p>
          {admission.item.sources.length > 0 && (
            <div className="memory-review-evidence">
              <p className="memory-caption">保存时的来源证据</p>
              {admission.item.sources.map((source, index) => (
                <p key={index} className="memory-caption">
                  {source.evidence ||
                    `对话 ${source.conversationId.slice(0, 8)} · 消息 ${source.messageId.slice(0, 8)}`}
                </p>
              ))}
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setSourceItem(admission.item)}
              >
                查看来源原文
              </button>
            </div>
          )}
          <ErrorNote text={actionError} />
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setAdmission(undefined)}
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
                  await post(`/memory/v1/memories/${admission.item.id}/admission`, {
                    version: admission.item.version,
                    decision: admission.decision,
                  });
                  setAdmission(undefined);
                  reload();
                } catch (error) {
                  setActionError((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '处理中…' : admission.decision === 'include' ? '确认纳入' : '确认撤回'}
            </button>
          </div>
        </Modal>
      )}
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
        {scope === 'user' && (
          <p className="memory-caption">
            {existing
              ? '修改长期记忆正文后会重新进入待纳入状态，需要再次审核确认。'
              : '保存后进入待纳入状态。请在记忆管理中审核，确认纳入后才会全局召回。'}
          </p>
        )}
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
