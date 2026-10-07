import { useEffect, useId, useState } from 'react';
import { Brain, Check, RefreshCw, X } from 'lucide-react';
import { api, post } from '../../client/api';
import { ErrorNote, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { ConversationGroup, Model } from '../../shared/types';
import type {
  MemoryOperation,
  MemoryPreferences,
  MemoryProposal,
  MemoryStatus,
  MemoryStrategyInfo,
} from '../../shared/memory';
import { MemorySettings } from './settings';
import './memory.css';

export { scopeLabels, kindLabels } from './labels';
import { scopeLabels, kindLabels, memoryDate as date } from './labels';
import { MemoryLibrary } from './library';

export function MemoryPage() {
  const { user } = useWorkspace();
  return <MemoryPageContent key={user.id} />;
}
export function MemorySettingsPage() {
  const { user } = useWorkspace();
  return <MemoryPageContent key={user.id} settings />;
}
function MemoryPageContent({ settings = false }: { settings?: boolean }) {
  const { data: status, error, reload } = useLoad(() => api<MemoryStatus>('/memory/v1/status'));
  return (
    <div className="page memory-page">
      <PageHeader
        eyebrow="MEMORY MANAGER"
        title={settings ? '记忆设置' : '记忆'}
        description={
          settings
            ? '选择模型与 Memory Policy，调整召回、抽取与保留设置。'
            : '整理可追溯的记忆。长期记忆经你确认纳入，分组记忆延续项目上下文。'
        }
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
          {status.ready && (
            <MemoryWorkspace status={status} reloadStatus={reload} settings={settings} />
          )}
        </>
      )}
    </div>
  );
}
function MemoryWorkspace({
  status,
  reloadStatus,
  settings,
}: {
  status: MemoryStatus;
  reloadStatus(): void;
  settings: boolean;
}) {
  const { user, conversationId } = useWorkspace();
  const [tab, setTab] = useState<'settings' | 'memories' | 'proposals' | 'indexes'>(
    settings ? 'settings' : conversationId === 'pending' ? 'proposals' : 'memories',
  );
  useEffect(() => {
    if (!settings) setTab(conversationId === 'pending' ? 'proposals' : 'memories');
  }, [settings, conversationId]);
  const tabs = [
    { id: 'memories', label: '记忆库' },
    { id: 'proposals', label: '待纳入与候选' },
    { id: 'settings', label: '策略设置' },
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
              key={user.id}
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
          {tab === 'proposals' && (
            <>
              <div className="memory-pending-heading">
                <h2>待纳入长期记忆</h2>
                <p className="memory-caption">
                  这些内容已经保存，但不会进入全局召回。核对正文与来源后，确认纳入才会在你的其他对话中使用，并记录纳入时间。
                </p>
              </div>
              <MemoryLibrary key="pending" groups={data.groups} pendingOnly />
              <MemoryProposals />
            </>
          )}
          {tab === 'indexes' && (
            <MemoryIndexes status={status} models={data.models} reloadStatus={reloadStatus} />
          )}
        </div>
      )}
    </>
  );
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
  const { navigate } = useWorkspace();
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
          ? '这些候选在回答完成后产生。长期记忆请前往记忆管理审核纳入。'
          : '长期候选在此确认纳入后参与全局召回；分组与 Session 候选确认后生效。拒绝不会修改原聊天。'}
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
              {compact && proposal.scope === 'user' && (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => navigate('memory', 'pending')}
                >
                  前往审核长期记忆
                </button>
              )}
              {(['approve', 'reject'] as const).map((decision) =>
                compact && proposal.scope === 'user' && decision === 'approve' ? null : (
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
                    {busy === proposal.id
                      ? '处理中…'
                      : decision === 'approve'
                        ? proposal.scope === 'user'
                          ? '确认纳入长期记忆'
                          : '确认保存'
                        : '拒绝'}
                  </button>
                ),
              )}
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
                {{
                  recall: '召回',
                  extract: '抽取',
                  remember: '回答记忆摘要',
                  write: '保存记忆',
                  rebuild: '索引重建',
                  index: '索引',
                }[operation.type] ?? operation.type}
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
