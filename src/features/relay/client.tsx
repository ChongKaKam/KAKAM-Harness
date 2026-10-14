import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Code, Copy, Eye, Inbox, Pencil, Pin, Plus, Search, Trash2 } from 'lucide-react';
import { api, patch, post, remove } from '../../client/api';
import { copyText } from '../../client/clipboard';
import { ColorPickerButton, usePatternColors } from '../../client/color-pattern';
import { Empty, ErrorNote, Modal, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { Markdown } from '../../client/markdown';
import { relayLimits, type RelayCard } from './types';
import './relay.css';

const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function RelayPage() {
  const { user } = useWorkspace();
  return <RelayWorkspace key={user.id} />;
}

function RelayWorkspace() {
  const { notify } = useWorkspace();
  const { data, error, reload } = useLoad(() => api<RelayCard[]>('/relay'));
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const [now, setNow] = useState(Date.now);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<RelayCard | 'new'>();
  const [confirmation, setConfirmation] = useState<{
    card: RelayCard;
    action: 'persist' | 'delete';
  }>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const refresh = () => {
      setNow(Date.now());
      reloadRef.current();
    };
    const timer = window.setInterval(refresh, 60_000);
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active.current = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  useEffect(() => {
    const deadlines = (data ?? []).flatMap((card) =>
      card.expiresAt && Date.parse(card.expiresAt) > Date.now() ? [Date.parse(card.expiresAt)] : [],
    );
    setNow(Date.now());
    if (!deadlines.length) return;
    const timer = window.setTimeout(
      () => {
        setNow(Date.now());
        reloadRef.current();
      },
      Math.max(0, Math.min(...deadlines) - Date.now()) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [data]);

  const cards = (data ?? []).filter((card) => !card.expiresAt || Date.parse(card.expiresAt) > now);
  const search = query.trim().toLocaleLowerCase();
  const visible = cards.filter(
    (card) =>
      (filter === 'all' || (filter === 'persistent' ? !!card.persistedAt : !card.persistedAt)) &&
      `${card.title}\n${card.content}`.toLocaleLowerCase().includes(search),
  );
  async function confirm() {
    if (!confirmation || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const { card, action } = confirmation;
      if (action === 'persist') await post(`/relay/${card.id}/persist`, { confirmed: true });
      else await remove(`/relay/${card.id}`);
      if (!active.current) return;
      setConfirmation(undefined);
      reload();
      notify(action === 'persist' ? '卡片已持久化' : '卡片已删除');
    } catch (error) {
      if (active.current) setActionError((error as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="page relay-page">
      <PageHeader
        eyebrow="YOUR INFORMATION RELAY"
        title="信息中转站"
        description="把需要的信息暂放这里。卡片三天后自动删除，确认持久化后长期保留。"
        action={
          <button type="button" className="button primary" onClick={() => setEditing('new')}>
            <Plus size={16} aria-hidden="true" />
            新建卡片
          </button>
        }
      />
      <ErrorNote text={error} />
      {error && (
        <button type="button" className="button" onClick={reload}>
          重新加载
        </button>
      )}
      <div className="relay-tools">
        <div className="relay-search">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索卡片"
            placeholder="搜索标题或内容"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="relay-filters" role="group" aria-label="按保留状态筛选">
          {(
            [
              ['all', '全部'],
              ['temporary', '临时'],
              ['persistent', '已持久化'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="relay-count" role="status">
          {visible.length} 张卡片
        </span>
      </div>
      {!data ? (
        !error && <Spinner />
      ) : !cards.length ? (
        <Empty title="给信息一个临时落脚点">从其他平台复制内容，再新建一张卡片粘贴到这里。</Empty>
      ) : !visible.length ? (
        <Empty title="没有匹配的卡片">试试其他关键词或保留状态。</Empty>
      ) : (
        <div className="relay-grid">
          {visible.map((card) => (
            <RelayCardView
              key={card.id}
              card={card}
              reload={reload}
              edit={() => setEditing(card)}
              confirm={(action) => {
                setActionError('');
                setConfirmation({ card, action });
              }}
            />
          ))}
        </div>
      )}
      {editing && (
        <RelayEditor
          card={editing === 'new' ? undefined : editing}
          close={() => setEditing(undefined)}
          saved={() => {
            setEditing(undefined);
            reload();
            notify(editing === 'new' ? '卡片已创建，将保留三天' : '卡片已更新');
          }}
        />
      )}
      {confirmation && (
        <Modal
          title={confirmation.action === 'persist' ? '持久化卡片' : '删除卡片'}
          close={() => !busy && setConfirmation(undefined)}
        >
          <p className="relay-confirm-copy">
            {confirmation.action === 'persist'
              ? `确认长期保留「${confirmation.card.title}」？确认后不再自动过期，直到你手动删除。`
              : `确认删除「${confirmation.card.title}」？此操作无法撤销。`}
          </p>
          <ErrorNote text={actionError} />
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? '处理中…' : confirmation.action === 'persist' ? '确认持久化' : '确认删除'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RelayCardView({
  card,
  reload,
  edit,
  confirm,
}: {
  card: RelayCard;
  reload: () => void;
  edit: () => void;
  confirm: (action: 'persist' | 'delete') => void;
}) {
  const colors = usePatternColors();
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  return (
    <article
      className="panel pattern-card relay-card"
      style={colors.style({ key: card.id, slot: card.colorSlot })}
      aria-label={card.title}
    >
      <div className="relay-card-top">
        <span className="relay-mark">
          <Inbox size={18} aria-hidden="true" />
        </span>
        <h2>{card.title}</h2>
        <ColorPickerButton
          label={card.title}
          value={card.colorSlot}
          colorKey={card.id}
          className="icon-button"
          onChange={async (colorSlot) => {
            await patch(`/relay/${card.id}`, { colorSlot });
            reload();
          }}
        />
      </div>
      <div className="relay-meta">
        {card.persistedAt ? (
          <span>
            <Pin size={14} aria-hidden="true" />
            已持久化 · 长期保留
          </span>
        ) : (
          <span>
            临时 · <time dateTime={card.expiresAt!}>{dateLabel(card.expiresAt!)} 到期</time>
          </span>
        )}
      </div>
      <div className="relay-content-tools">
        <button
          type="button"
          className="button"
          aria-label={source ? '切换为渲染模式' : '切换为源码模式'}
          aria-pressed={source}
          onClick={() => setSource(!source)}
        >
          {source ? <Eye size={15} aria-hidden="true" /> : <Code size={15} aria-hidden="true" />}
          {source ? '渲染' : '源码'}
        </button>
        <button
          type="button"
          className="button"
          aria-label="复制 Markdown"
          title="复制完整 Markdown 原文"
          onClick={async () => {
            try {
              await copyText(card.content);
              setError('');
              setCopied(true);
              window.clearTimeout(copyTimer.current);
              copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
            } catch {
              setError('复制失败，请切换源码模式后手动复制');
            }
          }}
        >
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          <span role="status">{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <div className="relay-content" role="region" aria-label={`${card.title} 的内容`} tabIndex={0}>
        {source ? (
          <pre className="relay-source">{card.content}</pre>
        ) : (
          <Markdown content={card.content} />
        )}
      </div>
      <ErrorNote text={error} />
      <div className="relay-card-footer">
        <button type="button" className="button" onClick={edit}>
          <Pencil size={15} aria-hidden="true" />
          编辑
        </button>
        {!card.persistedAt && (
          <button type="button" className="button" onClick={() => confirm('persist')}>
            <Pin size={15} aria-hidden="true" />
            持久化
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={`删除 ${card.title}`}
          onClick={() => confirm('delete')}
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}

function RelayEditor({
  card,
  close,
  saved,
}: {
  card?: RelayCard;
  close: () => void;
  saved: () => void;
}) {
  const [title, setTitle] = useState(card?.title ?? '');
  const [content, setContent] = useState(card?.content ?? '');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!content.trim()) {
      setError('请粘贴卡片内容');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (card) await patch(`/relay/${card.id}`, { title, content });
      else await post('/relay', { title, content });
      if (active.current) saved();
    } catch (error) {
      if (active.current) setError((error as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={card ? '编辑卡片' : '新建卡片'}
      close={() => !busy && close()}
      className="relay-editor"
    >
      <form onSubmit={save}>
        <label>
          标题
          <input
            autoFocus
            value={title}
            maxLength={relayLimits.title}
            placeholder="可选，给这份信息起个名字"
            disabled={busy}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <div className="relay-editor-toolbar">
          <span>Markdown 内容</span>
          <button
            type="button"
            className="button"
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? <Code size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            {preview ? '编辑源码' : '预览渲染'}
          </button>
        </div>
        {preview ? (
          <div className="relay-editor-preview" role="region" aria-label="卡片预览" tabIndex={0}>
            {content.trim() ? (
              <Markdown content={content} />
            ) : (
              <p className="muted">粘贴内容后即可预览。</p>
            )}
          </div>
        ) : (
          <textarea
            aria-label="Markdown 内容"
            value={content}
            maxLength={relayLimits.content}
            placeholder="把其他平台的内容粘贴到这里，支持标题、列表、表格和代码块。"
            disabled={busy}
            onChange={(event) => setContent(event.target.value)}
          />
        )}
        <p className="relay-editor-hint">
          {card
            ? card.persistedAt
              ? '已持久化：内容修改后仍长期保留。'
              : `编辑不会延长保留时间，${dateLabel(card.expiresAt!)} 到期。`
            : '创建后保留 72 小时。保存后可在卡片中确认持久化。'}
        </p>
        <ErrorNote text={error} />
        <div className="modal-actions">
          <button type="button" className="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? '保存中…' : '保存卡片'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
