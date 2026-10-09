import { SkillChips, useChatSkills } from '../skills/chat-controls';
import { SkillDetails } from '../skills/message-details';
import { ContextDrawer } from '../context-manager/drawer';
import { RememberDialog } from '../memory/remember';
import { MessageArtifacts } from '../llm-production/message-artifacts';
import { useProductionMode } from '../llm-production/use-production-mode';
import type { ProductionMode } from '../llm-production/types';
import { useExtensions } from '../extensions/chat-controls';
import { ExtensionDetails } from '../extensions/message-details';
import { useEffect, useRef, useState, type ChangeEvent, type SetStateAction } from 'react';
import {
  ArrowUp,
  ArrowDown,
  X,
  Square,
  ArrowUpRight,
  Copy,
  Check,
  Pencil,
  RefreshCw,
  GitBranch,
  BookmarkPlus,
} from 'lucide-react';
import { UserAvatar } from '../../client/user-avatar';
import { ModelPicker } from './model-picker';
import { ComposerActions } from './composer-actions';
import { RegenerateDialog } from './regenerate-dialog';
import { emptyChatDraft } from './use-chat-drafts';
import { LiveComposer, type ComposerHandle } from './composer';
import { post } from '../../client/api';
import { useConversation } from './use-conversation';
import { useChatNavigation } from './use-chat-navigation';
import { ConversationOutline } from './outline';
import { useWorkspace } from '../../client/context';
import { AssistantAvatar } from '../../client/ui-preferences';
import { TokenUsage } from './token-usage';
import { GenerationTime } from './generation-time';
import { copyText } from '../../client/clipboard';
import { Markdown } from '../../client/markdown';
import { ErrorNote, Spinner } from '../../client/components';
import type { Attachment, ReasoningEffort } from '../../shared/types';

function sourceMessageTarget() {
  const [page, , messageId] = window.location.hash.replace(/^#\/?/, '').split('/');
  return page === 'chat' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId ?? '')
    ? messageId
    : undefined;
}
export function ChatPage() {
  const {
    user,
    models,
    features,
    conversations,
    conversationId,
    navigate,
    refresh,
    chatDraft,
    setChatDraft,
    notify,
  } = useWorkspace();
  const extensions = useExtensions(user.id, features);
  const skills = useChatSkills(conversationId);
  const [revision, setRevision] = useState(0);
  const [formatting, setFormatting] = useState(false);
  useEffect(() => setFormatting(false), [user.id, conversationId]);
  const {
    messages,
    loading,
    reconnecting,
    error: streamError,
  } = useConversation(user.id, conversationId, revision, refresh);
  const production = useProductionMode(user.id, conversationId);
  const scroll = useChatNavigation(conversationId, messages, loading);
  const [sourceTarget, setSourceTarget] = useState(sourceMessageTarget);
  const sourceJump = useRef('');
  useEffect(() => {
    const update = () => setSourceTarget(sourceMessageTarget());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (!sourceTarget) {
      sourceJump.current = '';
      return;
    }
    const target = `${conversationId}:${sourceTarget}`;
    if (
      loading ||
      !sourceTarget ||
      sourceJump.current === target ||
      !messages.some((message) => message.id === sourceTarget)
    )
      return;
    sourceJump.current = target;
    scroll.jumpTo(sourceTarget);
  }, [conversationId, sourceTarget, loading, messages, scroll.jumpTo]);
  const [modelId, setModelId] = useState(localStorage.getItem('kh:model') ?? '');
  const [effort, setEffort] = useState<ReasoningEffort>('none');
  useEffect(() => {
    const saved = localStorage.getItem(`drift:effort:${user.id}:${modelId}`);
    setEffort(
      ['low', 'medium', 'high', 'xhigh', 'max'].includes(saved ?? '')
        ? (saved as ReasoningEffort)
        : 'none',
    );
  }, [user.id, modelId]);
  const { content: draft, images, editing } = chatDraft;
  function setDraft(update: SetStateAction<string>) {
    setChatDraft((current) => ({
      ...current,
      content: typeof update === 'function' ? update(current.content) : update,
    }));
  }
  function setImages(update: SetStateAction<Attachment[]>) {
    setChatDraft((current) => ({
      ...current,
      images: typeof update === 'function' ? update(current.images) : update,
    }));
  }
  function setEditing(editing: typeof chatDraft.editing) {
    setChatDraft((current) => ({ ...current, editing }));
  }
  const [submittingViews, setSubmittingViews] = useState<Set<string>>(() => new Set());
  const viewKey = `${user.id}:${conversationId ?? 'new'}`;
  const submitting = submittingViews.has(viewKey);
  const busy = submitting || messages.some((message) => message.status === 'streaming');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [regenerating, setRegenerating] = useState<string>();
  const contextEnabled = features.some(
    (feature) => feature.id === 'context-manager' && feature.enabled,
  );
  const memoryEnabled = features.some((feature) => feature.id === 'memory' && feature.enabled);
  const productionEnabled = features.some(
    (feature) => feature.id === 'llm-production' && feature.enabled,
  );
  const [rememberTurn, setRememberTurn] = useState<{
    userId: string;
    conversationId: string;
    messageId: string;
  }>();
  useEffect(() => setRememberTurn(undefined), [user.id, conversationId, memoryEnabled]);
  const [contextTurn, setContextTurn] = useState<{
    userId: string;
    conversationId: string;
    messageId: string;
  }>();
  useEffect(() => setContextTurn(undefined), [user.id, conversationId, contextEnabled]);
  const mounted = useRef(true);
  const viewId = useRef(conversationId);
  viewId.current = conversationId;
  const ownerId = useRef(user.id);
  ownerId.current = user.id;
  const pending = useRef(new Map<string, { requestId: string; body: string }>());
  const input = useRef<ComposerHandle>(null);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!localStorage.getItem('kh:model') || !models.some((m) => m.id === modelId))
      setModelId(models[0]?.id ?? '');
  }, [models, modelId]);
  useEffect(() => {
    setError('');
    setRegenerating(undefined);
  }, [conversationId]);
  useEffect(() => {
    pending.current.clear();
    setSubmittingViews(new Set());
    setError('');
    setRegenerating(undefined);
  }, [user.id]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function addImages(e: ChangeEvent<HTMLInputElement>) {
    const startingOwner = user.id;
    const startingView = conversationId;
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length + images.length > 4) {
      setError('每条消息最多添加 4 张图片');
      return;
    }
    try {
      const attachments = await Promise.all(
        files.map(
          (f) =>
            new Promise<Attachment>((resolve, reject) => {
              if (
                !['image/png', 'image/jpeg', 'image/webp'].includes(f.type) ||
                f.size > 5 * 1024 * 1024
              ) {
                reject(new Error('请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片'));
                return;
              }
              const reader = new FileReader();
              reader.onload = () => resolve({ name: f.name, data: String(reader.result) });
              reader.onerror = () => reject(new Error('图片读取失败'));
              reader.readAsDataURL(f);
            }),
        ),
      );
      if (ownerId.current !== startingOwner || viewId.current !== startingView) return;
      setImages((prev) => [...prev, ...attachments]);
      setError('');
    } catch (e) {
      if (ownerId.current === startingOwner && viewId.current === startingView)
        setError((e as Error).message);
    }
  }
  async function send(retry?: {
    id: string;
    content: string;
    images: Attachment[];
    productionMode?: ProductionMode;
    modelId?: string;
    reasoningEffort?: ReasoningEffort;
  }) {
    const replyModelId = retry?.modelId ?? modelId;
    const productionMode = retry ? (retry.productionMode ?? 'auto') : production.mode;
    if (
      busy ||
      loading ||
      extensions.saving ||
      extensions.loading ||
      skills.loading ||
      !!skills.error ||
      !replyModelId ||
      (!retry && !draft.trim() && !images.length)
    )
      return;
    if (
      productionMode === 'required' &&
      !models.find((model) => model.id === replyModelId)?.toolCalling
    ) {
      setError('此提问要求交付产物，请选择已启用工具调用的模型后发送或重试。');
      return;
    }
    const originalDraft = chatDraft;
    const text = retry ? retry.content : draft.trim();
    const attachments = retry ? retry.images : images;
    const selectedSkills = skills.selected;
    const startingId = conversationId;
    const startingOwner = user.id;
    const startingKey = viewKey;
    const currentView = (id?: string) =>
      mounted.current &&
      ownerId.current === startingOwner &&
      (viewId.current === id || viewId.current === startingId);
    scroll.latest();
    setSubmittingViews((current) => new Set(current).add(startingKey));
    setError('');
    let id = startingId;
    const body = {
      modelId: replyModelId,
      content: text,
      images: attachments,
      ...(retry || editing ? { replaceLastMessageId: retry?.id ?? editing?.id } : {}),
      reasoningEffort: retry?.reasoningEffort ?? effort,
      productionMode,
      extensions: extensions.modes,
      skills: skills.selected.map(({ id, version, scope }) => ({ id, version, scope })),
    };
    try {
      if (!id) {
        id = (await post<{ id: string }>('/conversations')).id;
        if (ownerId.current !== startingOwner) return;
        setSubmittingViews((current) => new Set(current).add(`${startingOwner}:${id}`));
        if (currentView(id)) {
          production.setMode(productionMode, id);
          if (!retry) setChatDraft(originalDraft, id);
          navigate('chat', id);
        }
      }
      const serialized = JSON.stringify(body);
      const pendingKey = `${startingOwner}:${id}`;
      const previous = pending.current.get(pendingKey);
      const requestId = previous?.body === serialized ? previous.requestId : crypto.randomUUID();
      pending.current.set(pendingKey, { requestId, body: serialized });
      // Submission is independent of the disposable SSE viewer and component lifecycle.
      await post(`/conversations/${id}/messages`, { ...body, requestId });
      pending.current.delete(pendingKey);
      // Clear only the accepted draft, even if another conversation is now visible.
      if (!retry) {
        const clearAccepted = (current: typeof chatDraft) =>
          current !== originalDraft
            ? current
            : current.productionMode === 'auto'
              ? emptyChatDraft
              : { ...emptyChatDraft, productionMode: current.productionMode };
        setChatDraft(clearAccepted);
        if (!startingId) {
          setChatDraft(clearAccepted, id);
          production.setMode('auto');
        }
      }
      if (currentView(id)) {
        scroll.latest();
        skills.accepted(selectedSkills);
        setRevision((value) => value + 1);
      }
    } catch (error) {
      if (currentView(id)) {
        setError((error as Error).message);
        if (!retry) setImages(attachments);
        skills.restore(selectedSkills);
        // A lost acknowledgement may still represent an accepted job; resubscribe, never auto-resend.
        setRevision((value) => value + 1);
      }
    } finally {
      if (mounted.current && ownerId.current === startingOwner)
        setSubmittingViews((current) => {
          const next = new Set(current);
          next.delete(startingKey);
          if (id) next.delete(`${startingOwner}:${id}`);
          return next;
        });
      await refresh().catch(() => {});
    }
  }
  async function stop() {
    if (conversationId) {
      const startingOwner = user.id;
      const startingId = conversationId;
      try {
        await post(`/conversations/${conversationId}/stop`);
      } catch (error) {
        if (mounted.current && ownerId.current === startingOwner && viewId.current === startingId)
          setError((error as Error).message);
      }
    }
  }
  const selected = models.find((m) => m.id === modelId);
  const empty = !conversationId && !messages.length;
  const lastUser = messages.at(-2)?.role === 'user' ? messages.at(-2) : undefined;
  const lastAssistant = messages.at(-1)?.role === 'assistant' ? messages.at(-1) : undefined;
  function editLastQuestion() {
    if (!lastUser || busy) return;
    setEditing({
      id: lastUser.id,
      previousDraft: draft,
      previousImages: images,
      previousProductionMode: production.mode,
    });
    setDraft(lastUser.content);
    setImages(lastUser.images);
    production.setMode(lastUser.productionMode ?? 'auto');
    input.current?.focus();
  }
  function cancelEdit() {
    if (!editing) return;
    setDraft(editing.previousDraft);
    setImages(editing.previousImages);
    production.setMode(editing.previousProductionMode);
    setEditing(undefined);
  }
  return (
    <div className={`chat-page ${empty ? 'is-home' : ''}`}>
      {!empty && (
        <ConversationOutline
          conversationId={conversationId}
          messages={messages}
          active={scroll.activeQuestion}
          jumpTo={scroll.jumpTo}
        />
      )}
      <div className="chat-column">
        <div
          className="chat-history"
          ref={scroll.viewport}
          role="region"
          aria-label="聊天记录"
          tabIndex={0}
        >
          {empty && (
            <div className="home-intro">
              <h1>
                你好，{user.displayName}。<br />
                <span>今天，想探索些什么？</span>
              </h1>
            </div>
          )}
          {loading && !messages.length ? (
            <Spinner />
          ) : (
            !empty && (
              <div className="messages" ref={scroll.content}>
                <div className="conversation-heading">
                  <span>
                    {conversations.find((c) => c.id === conversationId)?.title ?? '新对话'}
                  </span>
                  <span>仅自己可见</span>
                </div>
                {messages.map((m) => (
                  <article key={m.id} data-message-id={m.id} className={`message ${m.role}`}>
                    <div className="message-author">
                      {m.role === 'assistant' ? (
                        <AssistantAvatar />
                      ) : (
                        <UserAvatar user={user} size="tiny" />
                      )}
                      <strong>{m.role === 'assistant' ? 'Chatbot' : user.displayName}</strong>
                      {m.modelName && <span>{m.modelName}</span>}
                      {m.id === sourceTarget && <span>来源消息</span>}
                    </div>
                    <div className="message-content">
                      <SkillDetails message={m} />
                      <ExtensionDetails runs={m.extensions} />
                      {m.images.length > 0 && (
                        <div className="message-images">
                          {m.images.map((img, i) => (
                            <img key={i} src={img.data} alt={img.name} />
                          ))}
                        </div>
                      )}
                      {m.content ? (
                        <Markdown content={m.content} streaming={m.status === 'streaming'} />
                      ) : m.status === 'streaming' ? (
                        !m.extensions?.some(
                          (run) => run.status === 'deciding' || run.status === 'running',
                        ) && (
                          <span className="thinking">
                            正在思考<span>•••</span>
                          </span>
                        )
                      ) : (
                        <span className="muted">
                          {m.status === 'cancelled' ? '已停止生成' : '未收到回复'}
                        </span>
                      )}
                      {m.status === 'error' && (
                        <small className="message-status">{m.error ?? '回复未完成'}</small>
                      )}
                      {m.status === 'cancelled' && m.content && (
                        <small className="message-status">已停止生成</small>
                      )}
                      <MessageArtifacts
                        artifacts={m.artifacts}
                        delivery={m.productionDelivery}
                        messageStatus={m.status}
                      />
                      {m.role === 'user' && m.id === lastUser?.id && !busy && !editing && (
                        <div className="chat-message-actions">
                          <button className="copy-button" onClick={editLastQuestion}>
                            <Pencil size={14} /> 编辑提问
                          </button>
                        </div>
                      )}
                      {m.role === 'assistant' && (m.status !== 'streaming' || contextEnabled) && (
                        <div className="chat-message-actions">
                          {m.content && m.status !== 'streaming' && (
                            <button
                              className="copy-button"
                              aria-label="复制回复"
                              onClick={async () => {
                                try {
                                  await copyText(m.content);
                                  setCopied(m.id);
                                  setTimeout(() => setCopied(''), 1800);
                                } catch {
                                  notify('浏览器未允许复制，请手动选择文本');
                                }
                              }}
                            >
                              {copied === m.id ? <Check size={14} /> : <Copy size={14} />}
                              <span>{copied === m.id ? '已复制' : '复制'}</span>
                            </button>
                          )}
                          {m.status !== 'streaming' && (
                            <>
                              <TokenUsage message={m} />
                              <GenerationTime message={m} />
                            </>
                          )}
                          {contextEnabled && conversationId && (
                            <button
                              type="button"
                              className="copy-button context-manager-trigger"
                              aria-label="查看本轮上下文"
                              onClick={() =>
                                setContextTurn({ userId: user.id, conversationId, messageId: m.id })
                              }
                            >
                              <GitBranch size={14} aria-hidden="true" />
                              上下文
                            </button>
                          )}
                          {memoryEnabled &&
                            conversationId &&
                            m.status === 'complete' &&
                            m.content && (
                              <button
                                type="button"
                                className="copy-button memory-remember-trigger"
                                aria-label="Remember it · 记住这条回复"
                                onClick={() =>
                                  setRememberTurn({
                                    userId: user.id,
                                    conversationId,
                                    messageId: m.id,
                                  })
                                }
                              >
                                <BookmarkPlus size={14} aria-hidden="true" />
                                Remember it
                              </button>
                            )}
                          {!editing &&
                            m.id === lastAssistant?.id &&
                            lastUser &&
                            m.status === 'complete' && (
                              <button
                                type="button"
                                className="copy-button"
                                disabled={busy || !modelId}
                                onClick={() => setRegenerating(viewKey)}
                              >
                                <RefreshCw size={14} /> 再次生成
                              </button>
                            )}
                          {!editing &&
                            m.id === lastAssistant?.id &&
                            lastUser &&
                            (m.status === 'error' || m.status === 'cancelled') && (
                              <button
                                className="copy-button"
                                disabled={busy || !modelId}
                                onClick={() =>
                                  void send({
                                    id: lastUser.id,
                                    content: lastUser.content,
                                    images: lastUser.images,
                                    productionMode: lastUser.productionMode,
                                  })
                                }
                              >
                                <RefreshCw size={14} /> 重新输出
                              </button>
                            )}
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )
          )}
        </div>
        <div className="composer-wrap">
          {!empty && scroll.away && (
            <button
              className="latest-message"
              aria-label="回到最新消息"
              title="回到最新消息"
              onClick={scroll.latest}
            >
              <ArrowDown size={20} />
            </button>
          )}
          <ErrorNote text={error || streamError || extensions.error || skills.error} />
          {skills.error && (
            <button className="button" onClick={skills.reload}>
              重新加载对话 Skill
            </button>
          )}
          {reconnecting && (
            <p className="chat-connection-note" role="status">
              连接恢复后会自动同步；已提交的回复仍在服务器上继续生成。
            </p>
          )}
          {!models.length && (
            <div className="notice">
              {user.role === 'admin' ? (
                <>
                  还没有可用模型。
                  <button onClick={() => navigate('models')}>
                    添加模型来源与白名单 <ArrowUpRight size={14} />
                  </button>
                </>
              ) : (
                '还没有向你授权的模型，请联系管理员。'
              )}
            </div>
          )}
          <div className="composer">
            {editing && (
              <div className="chat-editing-note">
                <span>正在修改最后一次提问 · 发送后将替换原提问和回复</span>
                <button type="button" onClick={cancelEdit} aria-label="取消编辑提问">
                  <X size={14} /> 取消
                </button>
              </div>
            )}
            <SkillChips controls={skills} disabled={busy || skills.loading} />
            <LiveComposer
              key={viewKey}
              ref={input}
              value={draft}
              onChange={setDraft}
              onSend={() => void send()}
              disabled={busy}
              formatting={formatting}
            />
            {images.length > 0 && (
              <div className="attachment-list">
                {images.map((img, i) => (
                  <div key={i}>
                    <img src={img.data} alt={img.name} />
                    <button
                      aria-label={`移除 ${img.name}`}
                      onClick={() => setImages((prev) => prev.filter((_, n) => n !== i))}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="composer-tools">
              <input
                ref={file}
                type="file"
                hidden
                accept="image/png,image/jpeg,image/webp"
                multiple
                onChange={addImages}
              />
              <ComposerActions
                key={viewKey}
                disabled={busy || loading}
                vision={!!selected?.vision}
                toolCalling={!!selected?.toolCalling}
                addImages={() => file.current?.click()}
                skills={skills}
                skillsEnabled={features.some(
                  (feature) => feature.id === 'prompts' && feature.enabled,
                )}
                productionEnabled={productionEnabled}
                productionMode={production.mode}
                onProductionMode={(value) => production.setMode(value)}
                formatting={formatting}
                onFormatting={setFormatting}
                extensions={extensions}
              />
              <span className="grow" />
              <ModelPicker
                models={models}
                modelId={modelId}
                effort={effort}
                disabled={busy}
                onModel={(id) => {
                  setModelId(id);
                  try {
                    localStorage.setItem('kh:model', id);
                  } catch {}
                }}
                onEffort={(value) => {
                  setEffort(value);
                  try {
                    localStorage.setItem(`drift:effort:${user.id}:${modelId}`, value);
                  } catch {}
                }}
              />
              {busy ? (
                <button
                  className="send-button"
                  aria-label="停止生成"
                  disabled={submitting}
                  onClick={stop}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="发送消息"
                  disabled={
                    !modelId ||
                    (production.mode === 'required' && !selected?.toolCalling) ||
                    (!draft.trim() && !images.length) ||
                    loading ||
                    extensions.saving ||
                    extensions.loading ||
                    skills.loading ||
                    !!skills.error
                  }
                  onClick={() => void send()}
                >
                  <ArrowUp size={20} />
                </button>
              )}
            </div>
          </div>
          <div className="composer-caption">
            <span className="desktop-hint">Enter 发送 · Shift + Enter 换行</span>
            <span>AI 可能会出错，请核实重要信息</span>
          </div>
        </div>
      </div>
      {regenerating === viewKey && lastUser && lastAssistant?.status === 'complete' && !editing && (
        <RegenerateDialog
          models={models}
          modelId={modelId}
          effort={effort}
          disabled={
            busy ||
            loading ||
            extensions.saving ||
            extensions.loading ||
            skills.loading ||
            !!skills.error
          }
          close={() => setRegenerating(undefined)}
          confirm={(newModelId, newEffort) => {
            setRegenerating(undefined);
            void send({
              id: lastUser.id,
              content: lastUser.content,
              images: lastUser.images,
              productionMode: lastUser.productionMode,
              modelId: newModelId,
              reasoningEffort: newEffort,
            });
          }}
        />
      )}
      {contextEnabled &&
        contextTurn?.userId === user.id &&
        contextTurn.conversationId === conversationId && (
          <ContextDrawer
            conversationId={contextTurn.conversationId}
            messageId={contextTurn.messageId}
            close={() => setContextTurn(undefined)}
          />
        )}
      {memoryEnabled &&
        rememberTurn?.userId === user.id &&
        rememberTurn.conversationId === conversationId && (
          <RememberDialog
            key={`${user.id}:${rememberTurn.messageId}`}
            conversationId={rememberTurn.conversationId}
            messageId={rememberTurn.messageId}
            close={() => setRememberTurn(undefined)}
          />
        )}
    </div>
  );
}
