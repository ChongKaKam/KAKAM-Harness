import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, GitCommitHorizontal, RefreshCw } from 'lucide-react';
import { api } from '../../client/api';
import { copyText } from '../../client/clipboard';
import { Empty, ErrorNote, Modal, Spinner } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { Markdown } from '../../client/markdown';
import { CharacterComposition } from './character-composition';
import { ContextAutomation } from './automation';
import { MemoryAfterTurn, MemoryTrace } from './memory-trace';
import type { MessageUsage } from '../../shared/types';
import type {
  ContextHandoff,
  ContextPreferences,
  ContextSection,
  ContextSnapshot,
  ContextSummary,
} from './types';
import './context-manager.css';

const statusLabels = {
  streaming: '生成中',
  complete: '已完成',
  error: '失败',
  cancelled: '已停止',
};
const number = (value: number) => value.toLocaleString('zh-CN');
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

function Usage({ usage }: { usage: MessageUsage | null }) {
  return (
    <p className="context-manager-usage">
      {usage
        ? `供应商上报 Token · 输入 ${number(usage.input)} / 输出 ${number(usage.output)} / 合计 ${number(usage.total)}`
        : 'Token 用量未上报'}
    </p>
  );
}

export function ContextDrawer({
  conversationId,
  messageId,
  close,
}: {
  conversationId: string;
  messageId: string;
  close: () => void;
}) {
  const { user } = useWorkspace();
  return (
    <Modal title="对话上下文" className="context-manager-drawer" close={close}>
      <DrawerContent
        key={`${user.id}:${conversationId}:${messageId}`}
        conversationId={conversationId}
        messageId={messageId}
      />
    </Modal>
  );
}

function DrawerContent({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  const [turns, setTurns] = useState<ContextSummary[]>();
  const [selected, setSelected] = useState(messageId);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const selectedTurn = turns?.find((turn) => turn.messageId === selected);
  const path = `/context-manager/conversations/${encodeURIComponent(conversationId)}`;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<ContextSummary[]>(`${path}/turns`, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setTurns(result);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [path, revision]);
  useEffect(() => {
    if (
      selectedTurn?.status !== 'streaming' &&
      !turns?.some((turn) => turn.trajectory?.status === 'pending')
    )
      return;
    const timer = window.setTimeout(() => setRevision((value) => value + 1), 3000);
    return () => window.clearTimeout(timer);
  }, [selectedTurn, turns, revision]);
  return (
    <div className="context-manager-body">
      <aside className="context-manager-history" aria-label="上下文历史">
        <div className="context-manager-history-heading">
          <h3>
            对话轨迹 <span>{turns?.length ?? '—'}</span>
          </h3>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新上下文记录"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <p className="context-manager-caption">逐轮保存上下文，保留提问的修订轨迹。</p>
        <ErrorNote text={error} />
        {!turns && !error && <Spinner />}
        {turns?.length === 0 && <p className="context-manager-caption">此对话还没有上下文记录。</p>}
        <ol className="context-manager-timeline">
          {turns?.map((turn, index) => (
            <li key={turn.messageId}>
              <button
                type="button"
                className="context-manager-commit"
                aria-current={turn.messageId === selected ? 'step' : undefined}
                onClick={() => setSelected(turn.messageId)}
              >
                <GitCommitHorizontal
                  className="context-manager-node"
                  size={20}
                  aria-hidden="true"
                />
                <span className="context-manager-commit-title">
                  {turn.trajectory?.status === 'ready'
                    ? turn.trajectory.title
                    : turn.prompt || '图片提问'}
                </span>
                {turn.trajectory?.status === 'ready' && (
                  <span className="context-manager-commit-intent">
                    意图 · {turn.trajectory.intent}
                  </span>
                )}
                <span className="context-manager-commit-meta">
                  <code>{turn.messageId.slice(0, 7)}</code> · 记录 {index + 1}
                </span>
                <span className="context-manager-commit-meta">{turn.modelName}</span>
                <span className="context-manager-commit-meta">
                  <time dateTime={turn.createdAt}>{date(turn.createdAt)}</time>
                </span>
                <span className={`context-manager-status is-${turn.status}`}>
                  {statusLabels[turn.status]}
                </span>
                {turn.replacesMessageId && (
                  <span className="context-manager-commit-meta">
                    修订 {turn.replacesMessageId.slice(0, 7)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <div className="context-manager-detail" role="region" aria-label="上下文组成" tabIndex={0}>
        {selectedTurn ? (
          <SnapshotContent
            key={selected}
            path={path}
            selected={selected}
            revision={revision}
            status={selectedTurn.status}
            conversationId={conversationId}
            refreshed={() => setRevision((value) => value + 1)}
          />
        ) : (
          turns && (
            <Empty title="这一轮没有上下文快照">
              插件启用前或停用期间的轮次未被记录。可以从对话轨迹中选择已有记录。
            </Empty>
          )
        )}
      </div>
    </div>
  );
}

function SnapshotContent({
  path,
  selected,
  revision,
  status,
  conversationId,
  refreshed,
}: {
  path: string;
  selected: string;
  revision: number;
  status: ContextSummary['status'];
  conversationId: string;
  refreshed(): void;
}) {
  const { features } = useWorkspace();
  const [snapshot, setSnapshot] = useState<ContextSnapshot>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<ContextSnapshot>(`${path}/turns/${encodeURIComponent(selected)}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setSnapshot(result);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [path, selected, revision, status]);
  return (
    <>
      <ErrorNote text={error} />
      {!snapshot && !error && <Spinner />}
      {snapshot && (
        <>
          <header className="context-manager-snapshot-heading">
            <div className="context-manager-kicker">
              <code>{snapshot.messageId.slice(0, 7)}</code>
              <span className={`context-manager-status is-${snapshot.status}`}>
                {statusLabels[snapshot.status]}
              </span>
            </div>
            <h3>
              {snapshot.trajectory?.status === 'ready'
                ? snapshot.trajectory.title
                : snapshot.prompt || '图片提问'}
            </h3>
            <p className="context-manager-caption">
              {snapshot.modelName} · {date(snapshot.createdAt)}
            </p>
            <dl className="context-manager-totals">
              <div>
                <dt>字符</dt>
                <dd>{number(snapshot.characters)}</dd>
              </div>
              <div>
                <dt>UTF-8 字节</dt>
                <dd>{number(snapshot.bytes)}</dd>
              </div>
              <div>
                <dt>图片</dt>
                <dd>{number(snapshot.imageCount)}</dd>
              </div>
              <div>
                <dt>模型请求</dt>
                <dd>{number(snapshot.requestCount)}</dd>
              </div>
            </dl>
            <Usage usage={snapshot.usage} />
            <p className="context-manager-caption">
              展示最近一次回答模型请求的上下文；模型请求为 0
              时，内容尚未发送。字符与字节是内容规模，不是 Token 估算；Token
              为本轮回答模型各次请求的上报合计。
            </p>
          </header>
          <ContextAutomation snapshot={snapshot} path={path} refreshed={refreshed} />
          <CharacterComposition snapshot={snapshot} />
          {snapshot.memory && (
            <MemoryTrace memory={snapshot.memory} conversationId={conversationId} />
          )}
          <div className="context-manager-sections">
            {snapshot.sections.map((section) => (
              <Section key={section.id} section={section} />
            ))}
          </div>
          {snapshot.error && <ErrorNote text={snapshot.error} />}
          <details className="context-manager-response">
            <summary>本轮回复</summary>
            <div className="context-manager-response-content">
              {snapshot.response ? (
                <Markdown content={snapshot.response} streaming={snapshot.status === 'streaming'} />
              ) : (
                <p className="context-manager-caption">
                  {snapshot.status === 'streaming'
                    ? '本轮仍在生成，尚未保存完整回复。'
                    : '这一轮没有回复内容。'}
                </p>
              )}
            </div>
          </details>
          {snapshot.status !== 'streaming' &&
            snapshot.memory &&
            snapshot.memory.status !== 'skipped' &&
            features.some((feature) => feature.id === 'memory' && feature.enabled) && (
              <MemoryAfterTurn conversationId={conversationId} messageId={snapshot.messageId} />
            )}
          <Handoff path={path} snapshot={snapshot} />
        </>
      )}
    </>
  );
}

const sectionNames = {
  system: 'System prompt',
  'long-term': '长期记忆',
  group: '分组记忆',
  session: 'Session 记忆',
  current: '当前 prompt',
};
function Section({ section }: { section: ContextSection }) {
  return (
    <details className="context-manager-section" open={section.id === 'current'}>
      <summary>
        <span className="context-manager-section-name">{sectionNames[section.id]}</span>
        <span className="context-manager-caption">
          {number(section.characters)} 字符 · {number(section.bytes)} B ·{' '}
          {number(section.imageCount)} 张图片
        </span>
      </summary>
      <div className="context-manager-section-content">
        <p className="context-manager-caption">{section.description}</p>
        {!section.entries.length && (
          <p className="context-manager-caption">
            {section.id === 'system' || section.id === 'long-term' || section.id === 'group'
              ? '未注入'
              : '暂无内容'}
          </p>
        )}
        {section.entries.map((entry, index) => (
          <details key={index} className="context-manager-entry" open={section.id === 'current'}>
            <summary>
              {entry.label}
              {entry.role && <span className="context-manager-caption"> · {entry.role}</span>}
            </summary>
            {entry.memoryId && (
              <p className="context-manager-caption">
                {entry.memoryDeleted
                  ? '此记忆已删除，快照正文已清理。'
                  : `记忆 ${entry.memoryId.slice(0, 8)} · v${entry.memoryVersion}${entry.memoryReason ? ` · ${entry.memoryReason}` : ''}`}
              </p>
            )}
            {entry.content && <pre>{entry.content}</pre>}
            {!!entry.images.length && (
              <ul>
                {entry.images.map((image, index) => (
                  <li key={index}>
                    {image.name} · {number(image.bytes)} B
                  </li>
                ))}
              </ul>
            )}
          </details>
        ))}
      </div>
    </details>
  );
}

function Handoff({ path, snapshot }: { path: string; snapshot: ContextSnapshot }) {
  const { models } = useWorkspace();
  const available = models.filter((model) => model.kind === 'llm' && model.enabled);
  const [modelId, setModelId] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ContextHandoff>();
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const missing = !!modelId && !available.some((model) => model.id === modelId);
  useEffect(() => {
    active.current = true;
    const preferences = new AbortController();
    api<ContextPreferences>('/context-manager/preferences', { signal: preferences.signal })
      .then((value) => {
        if (!preferences.signal.aborted) setModelId(value.handoffModelId ?? '');
      })
      .catch((error: Error) => {
        if (!preferences.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!preferences.signal.aborted) setReady(true);
      });
    return () => {
      active.current = false;
      preferences.abort();
      controller.current?.abort();
    };
  }, []);
  async function generate() {
    if (busy || !modelId || missing || snapshot.status === 'streaming') return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const value = await api<ContextHandoff>(`${path}/handoff`, {
        method: 'POST',
        body: JSON.stringify({ messageId: snapshot.messageId, modelId }),
        signal: request.signal,
      });
      if (!request.signal.aborted && active.current) setResult(value);
    } catch (error) {
      if (!request.signal.aborted && active.current) setError((error as Error).message);
    } finally {
      if (!request.signal.aborted && active.current) setBusy(false);
    }
  }
  return (
    <section className="context-manager-handoff" aria-label="Hand-off 交接">
      <h3>Hand-off 交接</h3>
      <p className="context-manager-caption">
        截至所选记录，整理用户意图轨迹、当前进度、后续方向与相关资料，供下一个 Agent 接续工作。
      </p>
      <label>
        Hand-off 模型
        <select
          value={modelId}
          disabled={!ready || busy}
          onChange={(event) => setModelId(event.target.value)}
        >
          <option value="">选择一个可用 LLM</option>
          {missing && (
            <option value={modelId} disabled>
              原模型已停用或未授权，请重新选择
            </option>
          )}
          {available.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} · {model.providerName}
            </option>
          ))}
        </select>
      </label>
      <p className="context-manager-caption">
        点击生成才会调用所选模型并计入真实用量。生成结果需核对，复制与下载不会再次调用模型。
      </p>
      {snapshot.status === 'streaming' && (
        <p className="context-manager-caption" role="status">
          本轮仍在生成，完成后可生成交接。
        </p>
      )}
      {!available.length && (
        <p className="context-manager-caption">当前没有可用 LLM，请先在模型管理中配置或授权。</p>
      )}
      <button
        type="button"
        className="button primary"
        disabled={!ready || busy || !modelId || missing || snapshot.status === 'streaming'}
        onClick={() => void generate()}
      >
        {busy ? '正在生成 Hand-off…' : result ? '重新生成 Hand-off' : '生成 Hand-off'}
      </button>
      <ErrorNote text={error} />
      {result && (
        <div className="context-manager-handoff-result">
          <div className="context-manager-handoff-actions">
            <button
              type="button"
              className="button"
              onClick={async () => {
                try {
                  await copyText(result.markdown);
                  if (active.current) setCopied(true);
                } catch {
                  if (active.current)
                    setError('浏览器未允许复制，请下载 Markdown 文档或手动选择文本。');
                }
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? '已复制 Hand-off' : '复制 Hand-off'}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' }),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = `handoff-${result.throughMessageId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 36)}.md`;
                link.click();
                window.setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              <Download size={16} />
              下载 Markdown
            </button>
          </div>
          <p className="context-manager-caption">
            {result.modelName} · {date(result.createdAt)} · 截至{' '}
            {result.throughMessageId.slice(0, 7)}
          </p>
          <Usage usage={result.usage} />
          <div className="context-manager-handoff-markdown">
            <Markdown content={result.markdown} />
          </div>
        </div>
      )}
    </section>
  );
}
