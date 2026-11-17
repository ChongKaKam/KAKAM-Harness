import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  Code,
  Copy,
  Download,
  Eye,
  Inbox,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { api, patch, post, remove } from '../../client/api';
import { copyText } from '../../client/clipboard';
import { ColorPickerButton, usePatternColors } from '../../client/color-pattern';
import { Empty, ErrorNote, Modal, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { Markdown } from '../../client/markdown';
import { attachmentSize, uploadAttachment } from './attachment-client';
import { relayLimits, type RelayAttachment, type RelayCard } from './types';
import './relay.css';

const dateLabel = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const expired = (expiresAt: string | null, now: number) =>
  expiresAt !== null && Date.parse(expiresAt) <= now;
const hasCardContent = (card: RelayCard) =>
  !card.contentExpired && (card.content || !card.attachments.length);

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
    attachment?: RelayAttachment;
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
    const currentTime = Date.now();
    let nextDeadline = Infinity;
    for (const card of data ?? []) {
      for (const { expiresAt } of [card, ...card.attachments]) {
        if (!expiresAt) continue;
        const deadline = Date.parse(expiresAt);
        if (deadline > currentTime) nextDeadline = Math.min(nextDeadline, deadline);
      }
    }
    setNow(currentTime);
    if (!Number.isFinite(nextDeadline)) return;
    const timer = window.setTimeout(
      () => {
        setNow(Date.now());
        reloadRef.current();
      },
      Math.max(0, nextDeadline - Date.now()) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [data]);

  const cards = (data ?? [])
    .map((card) => {
      const contentExpired = card.contentExpired || expired(card.expiresAt, now);
      return {
        ...card,
        title: contentExpired ? '附件卡片' : card.title,
        contentExpired,
        attachments: card.attachments.filter((attachment) => !expired(attachment.expiresAt, now)),
      };
    })
    .filter((card) => !card.contentExpired || card.attachments.length > 0);
  const search = query.trim().toLocaleLowerCase();
  const visible = cards.filter((card) => {
    const matchesRetention = (persistedAt: string | null) =>
      filter === 'all' || (filter === 'persistent' ? !!persistedAt : !persistedAt);
    const matchesSearch = (text: string) => text.toLocaleLowerCase().includes(search);
    return (
      ((hasCardContent(card) && matchesRetention(card.persistedAt)) ||
        card.attachments.some((attachment) => matchesRetention(attachment.persistedAt))) &&
      (matchesSearch(card.title) ||
        (!card.contentExpired && matchesSearch(card.content)) ||
        card.attachments.some((attachment) => matchesSearch(attachment.filename)))
    );
  });
  async function confirm() {
    if (!confirmation || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const { card, attachment, action } = confirmation;
      const path = `/relay/${card.id}${attachment ? `/attachments/${attachment.id}` : ''}`;
      if (action === 'persist') await post(`${path}/persist`, { confirmed: true });
      else await remove(path);
      if (!active.current) return;
      setConfirmation(undefined);
      reload();
      notify(`${attachment ? '附件' : '卡片'}${action === 'persist' ? '已持久化' : '已删除'}`);
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
        description="跨设备保存文字和附件。默认保留三天，可分别设置长期保留。"
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
            placeholder="搜索标题、内容或附件名"
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
        <Empty title="暂无中转卡片">新建卡片粘贴文字或上传附件。</Empty>
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
              confirm={(action, attachment) => {
                setActionError('');
                setConfirmation({ card, action, attachment });
              }}
            />
          ))}
        </div>
      )}
      {editing && (
        <RelayEditor
          card={editing === 'new' ? undefined : editing}
          close={() => setEditing(undefined)}
          reload={reload}
          saved={() => {
            setEditing(undefined);
            notify(editing === 'new' ? '卡片已创建，将保留三天' : '卡片已更新');
          }}
        />
      )}
      {confirmation && (
        <Modal
          title={`${confirmation.action === 'persist' ? '持久化' : '删除'}${confirmation.attachment ? '附件' : '卡片'}`}
          close={() => !busy && setConfirmation(undefined)}
        >
          <p className="relay-confirm-copy">{confirmationText(confirmation)}</p>
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

function confirmationText({
  card,
  attachment,
  action,
}: {
  card: RelayCard;
  attachment?: RelayAttachment;
  action: 'persist' | 'delete';
}) {
  if (attachment)
    return action === 'persist'
      ? `确认长期保留附件「${attachment.filename}」？`
      : `确认删除附件「${attachment.filename}」？此操作无法撤销。`;
  if (action === 'persist')
    return `确认长期保留卡片「${card.title}」？附件的保留时间需要单独设置。`;
  return `确认删除卡片「${card.title}」？${card.attachments.length ? '所有附件也会一并删除。' : ''}此操作无法撤销。`;
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
  confirm: (action: 'persist' | 'delete', attachment?: RelayAttachment) => void;
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
        {!card.contentExpired && (
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
        )}
      </div>
      {card.contentExpired ? (
        <div className="relay-meta">卡片内容已到期</div>
      ) : hasCardContent(card) ? (
        <div className="relay-meta">
          <RelayRetention expiresAt={card.expiresAt} />
        </div>
      ) : null}
      {card.content && !card.contentExpired ? (
        <>
          <div className="relay-content-tools">
            <button
              type="button"
              className="button"
              aria-label={source ? '切换为渲染模式' : '切换为源码模式'}
              aria-pressed={source}
              onClick={() => setSource(!source)}
            >
              {source ? (
                <Eye size={15} aria-hidden="true" />
              ) : (
                <Code size={15} aria-hidden="true" />
              )}
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
              {copied ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              <span role="status">{copied ? '已复制' : '复制'}</span>
            </button>
          </div>
          <div
            className="relay-content"
            role="region"
            aria-label={`${card.title} 的内容`}
            tabIndex={0}
          >
            {source ? (
              <pre className="relay-source">{card.content}</pre>
            ) : (
              <Markdown content={card.content} />
            )}
          </div>
        </>
      ) : null}
      <RelayAttachmentList card={card} confirm={confirm} />
      <ErrorNote text={error} />
      <div className="relay-card-footer">
        {!card.contentExpired ? (
          <button type="button" className="button" title="编辑正文与附件" onClick={edit}>
            <Pencil size={15} aria-hidden="true" />
            编辑
          </button>
        ) : null}
        {hasCardContent(card) && !card.persistedAt ? (
          <button type="button" className="button" onClick={() => confirm('persist')}>
            <Pin size={15} aria-hidden="true" />
            持久化
          </button>
        ) : null}
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

function RelayRetention({ expiresAt }: { expiresAt: string | null }) {
  return expiresAt ? (
    <span>
      临时 · <time dateTime={expiresAt}>{dateLabel(expiresAt)} 到期</time>
    </span>
  ) : (
    <span>
      <Pin size={14} aria-hidden="true" />
      已持久化 · 长期保留
    </span>
  );
}

function RelayAttachmentList({
  card,
  confirm,
}: {
  card: RelayCard;
  confirm: (action: 'persist' | 'delete', attachment: RelayAttachment) => void;
}) {
  if (!card.attachments.length) return null;
  return (
    <ul className="relay-attachments" aria-label="附件">
      {card.attachments.map((attachment) => (
        <li key={attachment.id} className="relay-attachment">
          <div className="relay-attachment-info">
            <div className="relay-attachment-name">
              <Paperclip size={15} aria-hidden="true" />
              <span>{attachment.filename}</span>
            </div>
            <div className="relay-meta relay-attachment-meta">
              <span>{attachmentSize(attachment.sizeBytes)}</span>
              <RelayRetention expiresAt={attachment.expiresAt} />
            </div>
          </div>
          <div className="relay-attachment-actions">
            <a
              href={`/api/relay/${card.id}/attachments/${attachment.id}/download`}
              className="icon-button"
              aria-label={`下载 ${attachment.filename}`}
              title="下载附件"
              download
            >
              <Download size={16} aria-hidden="true" />
            </a>
            {!attachment.persistedAt ? (
              <button
                type="button"
                className="icon-button"
                aria-label={`持久化附件 ${attachment.filename}`}
                title="持久化附件"
                onClick={() => confirm('persist', attachment)}
              >
                <Pin size={16} aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              className="icon-button"
              aria-label={`删除附件 ${attachment.filename}`}
              title="删除附件"
              onClick={() => confirm('delete', attachment)}
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RelayEditor({
  card,
  close,
  reload,
  saved,
}: {
  card?: RelayCard;
  close: () => void;
  reload: () => void;
  saved: () => void;
}) {
  const [title, setTitle] = useState(card?.title ?? '');
  const [content, setContent] = useState(card?.content ?? '');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ file: File; received: number }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController>(null);
  const savedCard = useRef(
    card ? { id: card.id, title: card.title, content: card.content } : undefined,
  );
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      operation.current?.abort();
    };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (operation.current) return;
    if (!content.trim() && savedCard.current?.content) {
      setError('卡片正文不能为空');
      return;
    }
    if (!content.trim() && !savedCard.current && !files.length) {
      setError('请填写卡片内容或选择附件');
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError('');
    let changed = false;
    let uploading: File | undefined;
    try {
      const current = savedCard.current;
      const nextContent = content.trim() ? content : '';
      if (current) {
        const changes = {
          ...(title !== current.title ? { title } : {}),
          ...(nextContent !== current.content ? { content: nextContent } : {}),
        };
        if (Object.keys(changes).length) {
          await patch(`/relay/${current.id}`, changes);
          savedCard.current = { id: current.id, title, content: nextContent };
          changed = true;
        }
      } else if (nextContent) {
        const created = await post<RelayCard>('/relay', { title, content: nextContent });
        savedCard.current = { id: created.id, title, content: nextContent };
        changed = true;
      }
      for (const file of files) {
        uploading = file;
        controller.signal.throwIfAborted();
        setProgress({ file, received: 0 });
        const id = await uploadAttachment({
          cardId: savedCard.current?.id,
          title,
          file,
          signal: controller.signal,
          onProgress: (received) => {
            if (active.current) setProgress({ file, received });
          },
        });
        savedCard.current ??= { id, title, content: '' };
        changed = true;
        if (active.current) setFiles((current) => current.filter((pending) => pending !== file));
      }
      if (active.current) saved();
    } catch (error) {
      if (active.current) {
        const message = controller.signal.aborted
          ? '上传已停止'
          : `${uploading ? `${uploading.name}：` : ''}${(error as Error).message}`;
        setError(changed ? `${message}。已完成的修改或附件已保存。` : message);
      }
    } finally {
      operation.current = null;
      if (active.current) {
        if (changed) reload();
        setProgress(undefined);
        setBusy(false);
      }
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
            disabled={busy}
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
        <section className="relay-editor-attachments" aria-label="上传附件">
          <div className="relay-attachment-picker">
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              disabled={busy}
              aria-label="选择附件"
              onChange={(event) => {
                const selected = Array.from(event.target.files ?? []);
                const oversized = selected.find((file) => file.size > relayLimits.attachmentBytes);
                setError(oversized ? `附件「${oversized.name}」超过 300 MB 上限` : '');
                setFiles((current) => [
                  ...current,
                  ...selected.filter((file) => file.size <= relayLimits.attachmentBytes),
                ]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={15} aria-hidden="true" />
              添加附件
            </button>
            <span className="relay-editor-hint">单个文件最多 300 MB，上传后保留 72 小时。</span>
          </div>
          {files.length ? (
            <ul className="relay-attachments" aria-label="待上传附件">
              {files.map((file, index) => (
                <li className="relay-attachment" key={`${file.name}-${index}`}>
                  <div className="relay-attachment-info">
                    <div className="relay-attachment-name">{file.name}</div>
                    <div className="relay-meta">{attachmentSize(file.size)}</div>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label={`移除 ${file.name}`}
                    onClick={() =>
                      setFiles((current) => current.filter((pending) => pending !== file))
                    }
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {progress ? (
            <div className="relay-upload-progress">
              <span className="relay-editor-hint">正在上传 {progress.file.name}</span>
              <progress
                aria-label={`上传 ${progress.file.name} 的进度`}
                max={progress.file.size || 1}
                value={progress.received}
              />
            </div>
          ) : null}
        </section>
        <ErrorNote text={error} />
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            disabled={busy && !progress}
            onClick={() => {
              if (progress) operation.current?.abort();
              else close();
            }}
          >
            {progress ? '停止上传' : '取消'}
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? '保存中…' : '保存卡片'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
