import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Folder,
  FolderOpen,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-react';
import { api } from '../../client/api';
import { Empty, ErrorNote, PageHeader, Spinner, useLoad } from '../../client/components';
import { usePatternColors } from '../../client/color-pattern';
import { useWorkspace } from '../../client/context';
import { SegmentedControl } from '../../client/segmented-control';
import type { Conversation, ConversationGroup } from '../../shared/types';
import { ProductionFileIcon, productionCategory, type ProductionCategory } from './file-icon';
import { ProductionLibrary } from './library';
import type { ProductionArtifact, ProductionList } from './types';
import { productionDate } from './presentation';
import './production.css';

interface ConversationSpace {
  key: string;
  conversationId: string | null;
  groupId: string | null;
  name: string;
  updatedAt: string;
  artifacts: ProductionArtifact[];
}

type OpenSpace =
  { kind: 'conversation'; space: ConversationSpace } | { kind: 'group'; group: ConversationGroup };

const typeOptions = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'document', label: '文档' },
  { value: 'web', label: '网页' },
] as const;

function conversationSpaces(artifacts: ProductionArtifact[], conversations: Conversation[]) {
  const sources = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const spaces = new Map<string, ConversationSpace>();
  for (const artifact of artifacts) {
    const source = artifact.conversationId ? sources.get(artifact.conversationId) : undefined;
    const key = artifact.conversationId ?? `deleted:${artifact.groupId ?? 'ungrouped'}`;
    let space = spaces.get(key);
    if (!space) {
      space = {
        key,
        conversationId: artifact.conversationId,
        groupId: artifact.groupId,
        name: source?.title ?? (artifact.conversationId ? artifact.spaceName : '已删除对话的产物'),
        updatedAt: artifact.createdAt,
        artifacts: [],
      };
      spaces.set(key, space);
    }
    space.artifacts.push(artifact);
    if (artifact.createdAt > space.updatedAt) space.updatedAt = artifact.createdAt;
  }
  return [...spaces.values()];
}

export function ProductionPage() {
  const { user } = useWorkspace();
  return <ProductionPageContent key={user.id} />;
}

function ProductionPageContent() {
  const { navigate } = useWorkspace();
  const colors = usePatternColors();
  const [scope, setScope] = useState('all');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | ProductionCategory>('all');
  const [sort, setSort] = useState('recent');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [open, setOpen] = useState<OpenSpace>();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<string | undefined>(undefined);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const { data, error, reload } = useLoad(async () => {
    const [files, conversations, groups] = await Promise.all([
      api<ProductionList>('/llm-production/artifacts'),
      api<Conversation[]>('/conversations'),
      api<ConversationGroup[]>('/conversation-groups'),
    ]);
    return { files, conversations, groups };
  });
  useEffect(() => {
    const changed = () => reload();
    window.addEventListener('drift:production-changed', changed);
    return () => window.removeEventListener('drift:production-changed', changed);
  }, []);
  useEffect(() => {
    if (open) detailHeading.current?.focus();
    else if (returnFocus.current) {
      (buttons.current.get(returnFocus.current) ?? buttons.current.get('group:all'))?.focus();
      returnFocus.current = undefined;
    }
  }, [open]);
  const spaces = data ? conversationSpaces(data.files.artifacts, data.conversations) : [];
  const query = search.trim().toLocaleLowerCase();
  const visible = spaces
    .filter(
      (space) =>
        (scope === 'all' || (scope === 'ungrouped' ? !space.groupId : space.groupId === scope)) &&
        (type === 'all' ||
          space.artifacts.some((artifact) => productionCategory(artifact) === type)) &&
        `${space.name} ${space.artifacts.map((artifact) => artifact.name).join(' ')}`
          .toLocaleLowerCase()
          .includes(query),
    )
    .sort((left, right) =>
      sort === 'name'
        ? left.name.localeCompare(right.name, 'zh-CN')
        : right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key),
    );
  const group = data?.groups.find((item) => item.id === scope);
  const detailGroupId = open?.kind === 'group' ? open.group.id : open?.space.groupId;
  const detailGroup = data?.groups.find((item) => item.id === detailGroupId);
  const detailName = open?.kind === 'group' ? open.group.name : open?.space.name;
  function bindButton(key: string, button: HTMLButtonElement | null) {
    if (button) buttons.current.set(key, button);
    else buttons.current.delete(key);
  }
  return (
    <div className="page llm-production-page">
      <PageHeader
        eyebrow="PRODUCTION SPACE"
        title="产物空间"
        description={
          data
            ? `${spaces.length} 个对话空间 · ${data.files.artifacts.length} 个产物`
            : '管理聊天生成的文件与图片'
        }
        action={
          <button
            type="button"
            className="button"
            onClick={() => navigate('settings', 'llm-production')}
          >
            <Settings size={16} aria-hidden="true" />
            产物设置
          </button>
        }
      />
      <ErrorNote text={error} />
      {!data && !error && <Spinner />}
      {error && (
        <button type="button" className="button" onClick={reload}>
          重新加载
        </button>
      )}
      {data &&
        (open ? (
          <div className="llm-production-detail">
            <button type="button" className="button" onClick={() => setOpen(undefined)}>
              <ArrowLeft size={16} aria-hidden="true" />
              返回产物空间
            </button>
            <div className="llm-production-detail-heading">
              <div>
                <h2 ref={detailHeading} tabIndex={-1}>
                  {detailName}
                </h2>
                <p>
                  {open.kind === 'group' ? '管理分组内全部共享产物' : '管理此对话生成的全部产物'}
                </p>
              </div>
              <div className="llm-production-actions">
                {open.kind === 'conversation' && detailGroup && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => setOpen({ kind: 'group', group: detailGroup })}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    查看分组全部产物
                  </button>
                )}
                {open.kind === 'conversation' && open.space.conversationId && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => navigate('chat', open.space.conversationId!)}
                  >
                    <ArrowUpRight size={16} aria-hidden="true" />
                    打开对话
                  </button>
                )}
              </div>
            </div>
            <ProductionLibrary
              conversationId={
                open.kind === 'conversation' ? (open.space.conversationId ?? undefined) : undefined
              }
              groupId={
                open.kind === 'group'
                  ? open.group.id
                  : !open.space.conversationId
                    ? (open.space.groupId ?? undefined)
                    : undefined
              }
              sourceConversationId={
                open.kind === 'conversation' ? open.space.conversationId : undefined
              }
              showSpace={open.kind === 'group'}
              refreshed={reload}
            />
          </div>
        ) : (
          <>
            <div className="llm-production-browse-toolbar">
              <label className="llm-production-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="搜索对话或产物"
                  placeholder="搜索对话或产物"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <SegmentedControl
                label="产物类型"
                value={type}
                options={typeOptions}
                onChange={setType}
              />
              <select
                aria-label="对话空间排序"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="recent">最近生成</option>
                <option value="name">对话名称</option>
              </select>
              <div className="llm-production-view-toggle" role="group" aria-label="显示方式">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="卡片视图"
                  aria-pressed={view === 'grid'}
                  onClick={() => setView('grid')}
                >
                  <LayoutGrid size={18} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="列表视图"
                  aria-pressed={view === 'list'}
                  onClick={() => setView('list')}
                >
                  <List size={18} aria-hidden="true" />
                </button>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="刷新产物空间"
                onClick={reload}
              >
                <RefreshCw size={18} aria-hidden="true" />
              </button>
            </div>
            <section
              className="llm-production-group-section"
              aria-labelledby="production-groups-heading"
            >
              <h2 id="production-groups-heading">分组空间</h2>
              <div className="llm-production-group-grid">
                {[
                  { id: 'all', name: '全部空间', colorSlot: null },
                  ...data.groups,
                  { id: 'ungrouped', name: '未分组', colorSlot: null },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="llm-production-group-card"
                    style={colors.style({ key: item.id, slot: item.colorSlot })}
                    aria-label={`筛选分组 ${item.name}`}
                    aria-pressed={scope === item.id}
                    ref={(button) => bindButton(`group:${item.id}`, button)}
                    onClick={() => setScope(item.id)}
                  >
                    <span className="llm-production-group-icon">
                      <Folder size={24} aria-hidden="true" />
                    </span>
                    <span>
                      <strong title={item.name}>{item.name}</strong>
                      <small>
                        {
                          spaces.filter(
                            (space) =>
                              item.id === 'all' ||
                              (item.id === 'ungrouped'
                                ? !space.groupId
                                : space.groupId === item.id),
                          ).length
                        }{' '}
                        个对话
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
            <section
              className="llm-production-conversation-section"
              aria-labelledby="production-conversations-heading"
            >
              <div className="llm-production-section-heading">
                <h2 id="production-conversations-heading">
                  对话空间 <span>{visible.length}</span>
                </h2>
                {group && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      returnFocus.current = `group:${group.id}`;
                      setOpen({ kind: 'group', group });
                    }}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    管理分组产物
                  </button>
                )}
              </div>
              {visible.length ? (
                <div
                  className={`llm-production-conversation-grid${view === 'list' ? ' is-list' : ''}`}
                  aria-label="对话产物空间"
                >
                  {visible.map((space) => (
                    <button
                      key={space.key}
                      type="button"
                      className="llm-production-conversation-card"
                      style={colors.style({ key: space.key })}
                      aria-label={`管理对话产物 ${space.name}`}
                      ref={(button) => bindButton(space.key, button)}
                      onClick={() => {
                        returnFocus.current = space.key;
                        setOpen({ kind: 'conversation', space });
                      }}
                    >
                      <span className="llm-production-conversation-cover">
                        <ProductionFileIcon artifacts={space.artifacts} />
                      </span>
                      <span className="llm-production-conversation-info">
                        <span className="llm-production-conversation-title">
                          <strong title={space.name}>{space.name}</strong>
                          <ChevronRight size={16} aria-hidden="true" />
                        </span>
                        <span className="llm-production-conversation-meta">
                          <span>{space.artifacts.length} 个产物</span>
                          <time dateTime={space.updatedAt} title={productionDate(space.updatedAt)}>
                            {new Date(space.updatedAt).toLocaleDateString('zh-CN', {
                              month: 'long',
                              day: 'numeric',
                            })}
                          </time>
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <Empty title={spaces.length ? '没有匹配的对话空间' : '还没有产物'}>
                  {spaces.length
                    ? '调整分组、类型或搜索关键词后再试。'
                    : '在聊天中生成文件或图片后，即可在这里管理。'}
                </Empty>
              )}
            </section>
          </>
        ))}
    </div>
  );
}
