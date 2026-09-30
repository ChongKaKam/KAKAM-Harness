import type { Skill, SkillSummary } from '../skills/types';
import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  ArrowUpRight,
  Trash2,
  BookOpen,
  Pencil,
  Search,
  X,
  Tag,
  Ellipsis,
} from 'lucide-react';
import { api, patch, remove } from '../../client/api';
import { ColorPickerButton, usePatternColors } from '../../client/color-pattern';
import { useWorkspace } from '../../client/context';
import { PageHeader, Empty, Modal, ErrorNote, useLoad, Spinner } from '../../client/components';
import { PromptEditor } from './editor';
import { normalizeTags, type PromptPreferences } from './types';
import './prompts.css';
import '../skills/skills.css';

export function PromptsPage() {
  const colors = usePatternColors();
  const { navigate, setDraftSkills, notify, user } = useWorkspace();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  const [actionError, setActionError] = useState('');
  const { data, error, reload } = useLoad(async () => {
    const [cards, preferences] = await Promise.all([
      api<SkillSummary[]>(`/skills?q=${encodeURIComponent(search)}`),
      api<PromptPreferences>('/skills/preferences'),
    ]);
    return { cards, preferences };
  }, [user.id, search]);
  const [editing, setEditing] = useState<Skill | 'new'>();
  const [deleting, setDeleting] = useState<SkillSummary>();
  const [deleteError, setDeleteError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [actionsFor, setActionsFor] = useState<string>();
  const [openingId, setOpeningId] = useState<string>();
  const returnFocus = useRef<HTMLElement | null>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const cards = data?.cards ?? [];
  const tags = normalizeTags([...cards.flatMap((card) => card.tags), ...selectedTags]).sort(
    (a, b) => a.localeCompare(b, 'zh-CN'),
  );

  const visible = cards.filter((card) => {
    return selectedTags.every((tag) =>
      card.tags.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase()),
    );
  });
  function rememberFocus() {
    returnFocus.current = document.activeElement as HTMLElement;
  }
  function closeEditor() {
    setEditing(undefined);
    setDeleting(undefined);
    requestAnimationFrame(() => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      else createButton.current?.focus();
    });
  }
  function toggleTag(tag: string) {
    setSelectedTags((previous) =>
      previous.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())
        ? previous.filter((value) => value.toLocaleLowerCase() !== tag.toLocaleLowerCase())
        : [...previous, tag],
    );
  }
  async function openEditor(card: SkillSummary) {
    rememberFocus();
    setActionError('');
    setOpeningId(card.id);
    try {
      setEditing(await api<Skill>(`/skills/${card.id}`));
      setActionsFor(undefined);
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setOpeningId(undefined);
    }
  }
  return (
    <div className="page prompts-page">
      <PageHeader
        eyebrow="YOUR SKILL LIBRARY"
        title="好的开始，值得收藏"
        description="收藏常用指令与参考文档，在聊天过程中随时载入。"
        action={
          <button
            type="button"
            className="button primary"
            ref={createButton}
            disabled={!data}
            onClick={() => {
              rememberFocus();
              setEditing('new');
            }}
          >
            <Plus size={16} aria-hidden="true" />
            新建Skill
          </button>
        }
      />
      <ErrorNote text={error || actionError} />
      {error && (
        <button type="button" className="button" onClick={reload}>
          重新加载
        </button>
      )}
      {!data ? (
        !error && <Spinner />
      ) : (
        <>
          {(!!cards.length || !!query || !!selectedTags.length) && (
            <div className="prompts-tools">
              <div className="prompts-search-row">
                <div className="prompts-search">
                  <Search size={18} aria-hidden="true" />
                  <input
                    type="search"
                    aria-label="搜索Skill"
                    placeholder="搜索标题、简介、正文或标签"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  {query && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="清空搜索"
                      onClick={() => {
                        setQuery('');
                        setSearch('');
                      }}
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
                <span className="prompts-result-count" role="status">
                  {query !== search ? '搜索中…' : `${visible.length} 个结果`}
                </span>
              </div>
              {!!tags.length && (
                <div className="prompts-filters" role="group" aria-label="按标签筛选">
                  <Tag size={15} aria-hidden="true" />
                  <button
                    type="button"
                    className="prompts-tag"
                    aria-pressed={!selectedTags.length}
                    onClick={() => setSelectedTags([])}
                  >
                    全部
                  </button>
                  {tags.map((tag) => (
                    <button
                      type="button"
                      className="prompts-tag"
                      key={tag.toLocaleLowerCase()}
                      aria-pressed={selectedTags.some(
                        (value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase(),
                      )}
                      onClick={() => toggleTag(tag)}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
              {!!selectedTags.length && (
                <p className="prompts-filter-note">
                  同时包含：{selectedTags.join('、')}
                  <button type="button" onClick={() => setSelectedTags([])}>
                    清除标签筛选
                  </button>
                </p>
              )}
            </div>
          )}
          {!cards.length && !query && !selectedTags.length ? (
            <Empty title="收藏你的第一个Skill">
              为经常做的事情存一个好开头，例如润色文章、阅读代码或规划学习。
            </Empty>
          ) : !visible.length ? (
            <Empty title="没有找到匹配的Skill">
              试试其他关键词，或
              <button
                type="button"
                className="prompts-reset"
                onClick={() => {
                  setQuery('');
                  setSearch('');
                  setSelectedTags([]);
                }}
              >
                清除搜索与筛选
              </button>
              。
            </Empty>
          ) : (
            <div className="prompt-grid">
              {visible.map((card) => (
                <article
                  className="panel prompt-card pattern-card"
                  key={card.id}
                  style={colors.style({ key: card.id, slot: card.colorSlot })}
                  aria-label={card.title}
                >
                  <div className="prompts-card-top">
                    <span className="prompts-card-mark">
                      <BookOpen size={17} aria-hidden="true" />
                    </span>
                    <div className="prompts-card-heading">
                      <h2 className="prompts-card-title">{card.title}</h2>
                      <span className="prompts-card-meta">
                        v{card.version} · {card.fileCount} 个参考文件
                      </span>
                    </div>
                    <button
                      type="button"
                      className="icon-button prompts-more-button"
                      aria-label={`更多操作 ${card.title}`}
                      aria-expanded={actionsFor === card.id}
                      onClick={() => setActionsFor(actionsFor === card.id ? undefined : card.id)}
                    >
                      <Ellipsis size={19} aria-hidden="true" />
                    </button>
                  </div>
                  {actionsFor === card.id && (
                    <div className="prompts-card-actions" aria-label={`${card.title} 的更多操作`}>
                      <ColorPickerButton
                        label={card.title}
                        value={card.colorSlot}
                        colorKey={card.id}
                        className="prompts-card-action"
                        text="设置颜色"
                        onChange={async (colorSlot) => {
                          await patch(`/skills/${card.id}/color`, { colorSlot });
                          reload();
                        }}
                      />
                      <button
                        type="button"
                        className="prompts-card-action prompts-delete-action"
                        title="删除Skill"
                        aria-label={`删除 ${card.title}`}
                        onClick={() => {
                          rememberFocus();
                          setActionsFor(undefined);
                          setDeleteError('');
                          setDeleting(card);
                        }}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                        删除
                      </button>
                    </div>
                  )}
                  <p className="prompts-card-description">
                    {card.description || '暂无简介，可编辑补充适用场景。'}
                  </p>
                  <div className="prompts-tags">
                    {card.tags.map((tag) => (
                      <button
                        type="button"
                        className="prompts-tag"
                        key={tag.toLocaleLowerCase()}
                        aria-label={`筛选标签 ${tag}`}
                        aria-pressed={selectedTags.some(
                          (value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase(),
                        )}
                        onClick={() => toggleTag(tag)}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  <div className="prompts-card-footer">
                    <button
                      type="button"
                      className="button prompts-edit-button"
                      aria-label={`编辑 ${card.title}`}
                      disabled={openingId === card.id}
                      onClick={() => void openEditor(card)}
                    >
                      <Pencil size={15} aria-hidden="true" />
                      {openingId === card.id ? '载入中…' : '编辑'}
                    </button>
                    <button
                      type="button"
                      className="button prompts-start-button"
                      onClick={() => {
                        setDraftSkills([
                          {
                            id: card.id,
                            version: card.version,
                            title: card.title,
                            scope: 'conversation',
                          },
                        ]);
                        navigate('chat');
                      }}
                    >
                      载入新对话
                      <ArrowUpRight size={15} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}
      {editing && data && (
        <PromptEditor
          card={editing === 'new' ? undefined : editing}
          preferences={data.preferences}
          knownTags={tags}
          close={closeEditor}
          saved={() => {
            closeEditor();
            reload();
            notify(editing === 'new' ? 'Skill已收藏' : 'Skill已更新');
          }}
        />
      )}
      {deleting && (
        <Modal title="删除Skill" close={() => !busy && closeEditor()}>
          <p className="prompts-delete-copy">
            删除「{deleting.title}」？此操作无法撤销，已发送的对话不会受到影响。
          </p>
          <ErrorNote text={deleteError} />
          <div className="modal-actions">
            <button type="button" className="button" disabled={busy} onClick={closeEditor}>
              取消
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setDeleteError('');
                try {
                  await remove(`/skills/${deleting.id}`);
                  closeEditor();
                  reload();
                  notify('Skill已删除');
                } catch (e) {
                  setDeleteError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '删除中…' : '确认删除'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
