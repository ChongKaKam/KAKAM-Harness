import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  BookOpen,
  Briefcase,
  Check,
  ChevronRight,
  Code2,
  Folder,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Conversation, ConversationGroup } from '../../shared/types';
import { useWorkspace } from '../../client/context';
import { usePatternColors } from '../../client/color-pattern';
import { ErrorNote, Modal } from '../../client/components';
import { patch, post, remove } from '../../client/api';
import { groupIcons, isGroupIcon, isGroupSymbol, type GroupIcon } from './groups';
import './conversation-list.css';

const icons = {
  folder: Folder,
  book: BookOpen,
  code: Code2,
  briefcase: Briefcase,
  sparkles: Sparkles,
};
const iconLabels = {
  folder: '文件夹',
  book: '阅读',
  code: '代码',
  briefcase: '工作',
  sparkles: '灵感',
};
function GroupSymbol({ value }: { value: string }) {
  const Icon = isGroupIcon(value) ? icons[value as GroupIcon] : undefined;
  return Icon ? <Icon size={16} aria-hidden="true" /> : <span aria-hidden="true">{value}</span>;
}

export function ConversationList({
  groups,
  search,
  activeId,
}: {
  groups: ConversationGroup[];
  search: string;
  activeId?: string;
}) {
  const { conversations, refresh, navigate, notify, setDraft } = useWorkspace();
  const colors = usePatternColors();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editingGroup, setEditingGroup] = useState<ConversationGroup | 'new'>();
  const [editingConversation, setEditingConversation] = useState<Conversation>();
  const [creating, setCreating] = useState(false);
  const newGroupButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentGroupId = conversations.find((c) => c.id === activeId)?.groupId;
  useEffect(() => {
    if (currentGroupId)
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(currentGroupId);
        return next;
      });
  }, [activeId, currentGroupId]);
  const query = search.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(query);
  function rememberFocus() {
    returnFocus.current = document.activeElement as HTMLElement;
  }
  function close() {
    setEditingGroup(undefined);
    setEditingConversation(undefined);
    requestAnimationFrame(() => {
      const target = returnFocus.current;
      if (target?.isConnected) target.focus();
      else newGroupButton.current?.focus();
    });
  }
  async function newConversation(groupId: string) {
    if (creating) return;
    setCreating(true);
    try {
      const { id } = await post<{ id: string }>('/conversations', { groupId });
      if (!mounted.current) return;
      setDraft('');
      navigate('chat', id);
      await refresh();
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setCreating(false);
    }
  }
  function row(conversation: Conversation) {
    return (
      <div
        className={`conversation-link ${activeId === conversation.id ? 'active' : ''}`}
        key={conversation.id}
      >
        <button
          type="button"
          className="conversation-open"
          aria-current={activeId === conversation.id ? 'page' : undefined}
          onClick={() => navigate('chat', conversation.id)}
          title={conversation.title}
        >
          <MessageSquare size={14} aria-hidden="true" />
          <span>{conversation.title}</span>
          {conversation.generating && (
            <span className="conversation-generating" aria-label="回复生成中">
              ···
            </span>
          )}
        </button>
        <button
          type="button"
          className="conversation-action"
          aria-label={`管理对话 ${conversation.title}`}
          onClick={() => {
            rememberFocus();
            setEditingConversation(conversation);
          }}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }
  const visibleGroups = groups
    .map((group) => ({
      group,
      members: conversations.filter(
        (c) => c.groupId === group.id && (matches(group.name) || matches(c.title)),
      ),
    }))
    .filter(({ group, members }) => !query || matches(group.name) || members.length);
  const ungrouped = conversations.filter((c) => !c.groupId && matches(c.title));
  return (
    <div className="chat-library">
      <div className="nav-label chat-library-heading">
        对话分组
        <button
          ref={newGroupButton}
          type="button"
          className="icon-button"
          aria-label="新建分组"
          onClick={() => {
            rememberFocus();
            setEditingGroup('new');
          }}
        >
          <FolderPlus size={16} aria-hidden="true" />
        </button>
      </div>
      {!groups.length && !query && (
        <button
          type="button"
          className="chat-group-create"
          onClick={() => {
            rememberFocus();
            setEditingGroup('new');
          }}
        >
          <Plus size={14} aria-hidden="true" />
          把相关想法放在一起
        </button>
      )}
      {visibleGroups.map(({ group, members }) => {
        const expanded = !!query || !collapsed.has(group.id);
        return (
          <section className="chat-group" key={group.id} aria-label={`分组 ${group.name}`}>
            <div
              className="chat-group-heading"
              style={colors.style({ key: group.id, slot: group.colorSlot })}
            >
              <button
                type="button"
                className="chat-group-toggle"
                aria-label={`分组 ${group.name}`}
                aria-expanded={expanded}
                aria-controls={`group-${group.id}`}
                onClick={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })
                }
              >
                <ChevronRight size={12} className="chat-group-chevron" aria-hidden="true" />
                <span className="chat-group-symbol">
                  <GroupSymbol value={group.icon} />
                </span>
                <span className="chat-group-name" title={group.name}>
                  {group.name}
                </span>
                <span className="chat-group-count">{members.length}</span>
              </button>
              <button
                type="button"
                className="chat-group-action"
                aria-label={`在 ${group.name} 中新建对话`}
                disabled={creating}
                onClick={() => void newConversation(group.id)}
              >
                <Plus size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="chat-group-action"
                aria-label={`编辑分组 ${group.name}`}
                onClick={() => {
                  rememberFocus();
                  setEditingGroup(group);
                }}
              >
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            </div>
            <div
              className="chat-group-conversations conversation-list"
              id={`group-${group.id}`}
              hidden={!expanded}
            >
              {members.map(row)}
              {!members.length && <p className="chat-group-empty">还没有对话，点击 + 开始</p>}
            </div>
          </section>
        );
      })}
      <div className="nav-label">
        {groups.length ? '未分组' : '最近对话'}
        <span>{ungrouped.length || ''}</span>
      </div>
      <div className="conversation-list">{ungrouped.map(row)}</div>
      {!conversations.length && !query && (
        <p className="sidebar-empty">你的想法，会在这里慢慢积累。</p>
      )}
      {!!query && !visibleGroups.length && !ungrouped.length && (
        <p className="sidebar-empty">没有找到相关对话或分组</p>
      )}
      {editingGroup && (
        <GroupEditor group={editingGroup === 'new' ? undefined : editingGroup} close={close} />
      )}
      {editingConversation && (
        <ConversationEditor conversation={editingConversation} groups={groups} close={close} />
      )}
    </div>
  );
}

function GroupEditor({ group, close }: { group?: ConversationGroup; close: () => void }) {
  const { refresh } = useWorkspace();
  const colors = usePatternColors();
  const [name, setName] = useState(group?.name ?? '');
  const [icon, setIcon] = useState(group?.icon ?? 'folder');
  const [colorSlot, setColorSlot] = useState<number | null>(group?.colorSlot ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [previewKey] = useState(() => group?.id ?? crypto.randomUUID());
  async function save() {
    if (!isGroupSymbol(icon)) {
      setError('请选择图标或输入一个 emoji');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (group) await patch(`/conversation-groups/${group.id}`, { name, icon, colorSlot });
      else await post('/conversation-groups', { name, icon, colorSlot });
      await refresh();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteGroup() {
    setBusy(true);
    setError('');
    try {
      await remove(`/conversation-groups/${group!.id}`);
      window.dispatchEvent(new Event('drift:production-changed'));
      await refresh();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={group ? '编辑分组' : '新建分组'} close={() => !busy && close()}>
      <form
        className="chat-group-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
      >
        <div
          className="chat-group-preview"
          style={colors.style({ key: previewKey, slot: colorSlot })}
        >
          <span className="chat-group-symbol">
            <GroupSymbol value={isGroupSymbol(icon) ? icon : 'folder'} />
          </span>
          <strong>{name.trim() || '给想法一个小天地'}</strong>
        </div>
        <label>
          分组名称
          <input
            autoFocus
            required
            maxLength={60}
            value={name}
            disabled={busy}
            placeholder="例如：工作、阅读、旅行计划"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset disabled={busy} className="chat-group-fieldset">
          <legend>分组图标</legend>
          <div className="chat-group-icons">
            {groupIcons.map((value) => (
              <button
                type="button"
                className="chat-symbol-choice"
                key={value}
                aria-label={iconLabels[value]}
                aria-pressed={icon === value}
                onClick={() => setIcon(value)}
              >
                <GroupSymbol value={value} />
              </button>
            ))}
            {['💡', '📚', '🌱', '🚀', '🎨', '☕️'].map((value) => (
              <button
                type="button"
                className="chat-symbol-choice"
                key={value}
                aria-label={value}
                aria-pressed={icon === value}
                onClick={() => setIcon(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <label className="chat-group-emoji">
            自定义 emoji
            <input
              aria-label="自定义 emoji"
              placeholder="或输入你喜欢的 emoji"
              maxLength={32}
              value={isGroupIcon(icon) ? '' : icon}
              onChange={(e) => setIcon(e.target.value || 'folder')}
            />
          </label>
        </fieldset>
        <fieldset disabled={busy} className="chat-group-fieldset">
          <legend>分组颜色 · {colors.pattern.name}</legend>
          <div className="chat-group-colors">
            <label className="chat-color-auto">
              <input
                type="radio"
                name="group-color"
                checked={colorSlot === null}
                onChange={() => setColorSlot(null)}
              />
              自动
            </label>
            {colors.pattern.colors.map((color, index) => (
              <label
                className="chat-color-choice"
                key={color.id}
                title={color.name}
                style={{ '--swatch': color.color } as CSSProperties}
              >
                <input
                  type="radio"
                  name="group-color"
                  aria-label={color.name}
                  checked={colorSlot !== null && colorSlot % colors.pattern.colors.length === index}
                  onChange={() => setColorSlot(index)}
                />
                <span>
                  {colorSlot !== null && colorSlot % colors.pattern.colors.length === index && (
                    <Check size={14} aria-hidden="true" />
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <ErrorNote text={error} />
        {deleting ? (
          <div className="chat-delete-confirm">
            <p>删除「{group?.name}」？其中的对话将移至未分组，消息会保留。</p>
            <p className="chat-production-note">
              未归入其他分组的产物会转为临时保留，到期后自动清理。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void deleteGroup()}
              >
                确认删除分组
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            {group && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={14} />
                删除分组
              </button>
            )}
            <button type="button" className="button" disabled={busy} onClick={close}>
              取消
            </button>
            <button type="submit" className="button primary" disabled={busy || !name.trim()}>
              {busy ? '保存中…' : group ? '保存分组' : '创建分组'}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function ConversationEditor({
  conversation,
  groups,
  close,
}: {
  conversation: Conversation;
  groups: ConversationGroup[];
  close: () => void;
}) {
  const { refresh, navigate, conversationId } = useWorkspace();
  const [title, setTitle] = useState(conversation.title);
  const [groupId, setGroupId] = useState(conversation.groupId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  async function save(removeConversation = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (removeConversation) {
        await remove(`/conversations/${conversation.id}`);
        if (conversationId === conversation.id) navigate('chat');
      } else {
        await patch(`/conversations/${conversation.id}`, { title, groupId: groupId || null });
        if (groupId !== (conversation.groupId ?? ''))
          window.dispatchEvent(new Event('drift:production-changed'));
      }
      await refresh();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="管理对话" close={() => !busy && close()}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          对话名称
          <input
            required
            maxLength={100}
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          所属分组
          <select value={groupId} disabled={busy} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">未分组</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {isGroupIcon(group.icon) ? '' : `${group.icon} `}
                {group.name}
              </option>
            ))}
          </select>
        </label>
        {groupId !== (conversation.groupId ?? '') && (
          <p className="chat-production-note">
            {groupId
              ? '新产物将使用所选分组空间，临时产物也会转入；已有分组产物保留在原分组。'
              : '新产物将使用对话临时空间；已有分组产物保留在原分组。'}
          </p>
        )}
        <ErrorNote text={error} />
        {deleting ? (
          <div className="chat-delete-confirm">
            <p>删除此对话及其中的消息？此操作无法撤销。</p>
            <p className="chat-production-note">
              此对话的临时产物也会删除；已在分组共享的产物会保留。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setDeleting(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void save(true)}
              >
                确认删除对话
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={14} />
              删除对话
            </button>
            <button type="submit" className="button primary" disabled={busy || !title.trim()}>
              {busy ? '保存中…' : '保存对话'}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
