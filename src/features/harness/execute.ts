import type { Context } from 'cordis';
import type { ProviderMessage } from '../../adapters/registry';
import {
  availableInputTokens,
  estimateMessageTokens,
  estimateRequestTokens,
} from '../../adapters/context-budget';
import {
  generationOutputLimit,
  generationRequest,
  requireLlmApiMode,
} from '../../adapters/generation-request';
import type {
  Attachment,
  ExtensionCall,
  Message,
  Model,
  ReasoningEffort,
  StreamEvent,
  User,
} from '../../shared/types';
import type { ProductionMode } from '../llm-production/types';
import type { SkillRead } from '../skills/types';
import type { SkillSession } from '../extensions/skill-runtime';
import type { ExtensionPlan } from '../extensions/server';
import type { ContextRecorder } from '../extensions/context-observer';
import { HttpError } from '../../kernel/http';
import { capabilityContext } from '../extensions/capability-context';
import { aggregateCalls, generateReply, prepareReplyTools } from '../chat/skill-generation';
import { generationDeadline } from '../chat/generation-deadline';
import { HarnessExecution } from './run';
import { listWorkspaceDocuments, loadWorkspaceContext, readWorkspaceDocument } from './workspace';
import { answerWhileSearching } from './search-preview';
import {
  rememberExplicitWorkspaceNote,
  requestedWorkspacePreference,
  workspaceInstructions,
} from './tools';

interface HarnessTask {
  conversationId: string;
  user: User;
  model: Model;
  input: {
    modelId: string;
    content: string;
    images: Attachment[];
    productionMode: ProductionMode;
    reasoningEffort: ReasoningEffort;
  };
  history: Message[];
  extensionPlan: ExtensionPlan[];
  session?: SkillSession;
  skillContext?: string;
  recorder?: ContextRecorder;
  message: Message;
  abort: AbortController;
  execution: HarnessExecution;
  broadcast(event: StreamEvent): void;
}

/** Run one admitted task. HTTP subscriptions and user concurrency slots belong to the caller. */
export async function executeHarness(ctx: Context, task: HarnessTask) {
  const {
    conversationId: id,
    user,
    model,
    input,
    history,
    extensionPlan,
    session,
    skillContext,
    recorder,
    execution,
    broadcast,
    message,
    abort,
  } = task;
  const { id: messageId, createdAt: now } = message;
  const context: ProviderMessage[] = [
    ...history.map(({ role, content, images }) => ({ role, content, images })),
    { role: 'user', content: input.content, images: input.images },
  ];
  const started = performance.now();

  let status: Message['status'] = 'complete';
  let checkpoint = Date.now();
  const deadline = generationDeadline(abort.signal, session?.plan.signal);
  const onText = (text: string) => {
    deadline.touch();
    message.content += text;
    if (message.content.length > 2_000_000) throw new HttpError(502, '回复过长，已停止生成');
    broadcast({ type: 'delta', messageId, text });
    if (Date.now() - checkpoint > 1500) {
      ctx.db.run('UPDATE messages SET content=? WHERE id=?', message.content, messageId);
      checkpoint = Date.now();
    }
  };
  let preparing: Promise<ProviderMessage[]> | undefined;
  const localAbort = new AbortController();
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let preview: Promise<void> | undefined;
  let waitingDetail: string | undefined;
  try {
    const signal = AbortSignal.any([deadline.signal, localAbort.signal]);
    let workspace: string;
    try {
      workspace = loadWorkspaceContext(ctx, user.id, id);
    } catch {
      workspace =
        '工作区资料本轮未成功载入。请用对话中已有材料回答，明确说明哪些项目背景有待确认。';
      execution.activity('工作区资料未能载入，继续处理当前问题', 'error');
    }
    const referenceMessages = context.map((message, index) =>
      index === context.length - 1
        ? {
            ...message,
            content: [message.content, skillContext].filter(Boolean).join('\n\n'),
          }
        : message,
    );
    const workspaceInput: ProviderMessage = {
      role: 'user',
      content:
        workspace +
        '\n\n' +
        (model.toolCalling ? workspaceInstructions : '') +
        '\nExplain principles first in ordinary knowledge Q&A. Mention relevant project decisions separately. For explicit design or continuation requests, develop the project-specific plan.',
    };
    const withWorkspace = (messages: ProviderMessage[]) => [
      ...messages.slice(0, -1),
      workspaceInput,
      messages.at(-1)!,
    ];
    // All three stages use the same dynamic permissions, tool schemas and delivery instructions.
    const preflight = (messages: ProviderMessage[]) => {
      const current = ctx.models.authorize(user, input.modelId, 'llm');
      const connection = ctx.models.connection(current);
      const mode = requireLlmApiMode(connection.apiMode);
      const tools = prepareReplyTools(
        ctx,
        {
          user,
          modelId: current.id,
          messageId,
          conversationId: id,
          requestContent: input.content,
          productionMode: input.productionMode,
          useWorkspace: true,
          signal,
          session,
        },
        Boolean(current.toolCalling && ctx.models.adapter(mode).generateTurn),
      );
      const window = connection.contextWindowTokens;
      if (!window) return { requiresDelivery: tools.requiresDelivery };
      const {
        tools: definitions,
        outstanding,
        roundMessages,
      } = tools.round(withWorkspace(messages));
      const body = generationRequest(
        mode,
        connection,
        current.name,
        roundMessages,
        input.reasoningEffort,
        definitions.length
          ? { tools: definitions, steps: [], requireTool: outstanding.length > 0 }
          : undefined,
      );
      return {
        requiresDelivery: tools.requiresDelivery,
        body,
        availableTokens: availableInputTokens(
          window,
          generationOutputLimit(mode, input.reasoningEffort, connection),
        ),
      };
    };
    // The current question and tool definitions survive compression. Check those before paying for a summary.
    const currentOnly = [referenceMessages.at(-1)!];
    const first = preflight(currentOnly);
    // Compress once before capabilities; both auxiliary and answer requests reuse it.
    const processed = await ctx.extensions.prepareContext({
      user,
      conversationId: id,
      messageId,
      modelId: input.modelId,
      modelName: model.label,
      createdAt: now,
      reasoningEffort: input.reasoningEffort,
      history,
      current: context.at(-1)!,
      messages: referenceMessages,
      contextBudget: first.body && {
        availableTokens: first.availableTokens,
        supplementalTokens: Math.max(
          0,
          estimateRequestTokens(first.body) - estimateMessageTokens(currentOnly),
        ),
      },
      signal,
    });
    deadline.touch();
    signal.throwIfAborted();
    if (!model.contextWindowTokens && processed.messages.length > 201)
      throw new HttpError(400, '对话较长，压缩未能缩减历史；请调整上下文压缩设置或新建对话');
    if (extensionPlan.length) preflight(processed.messages);
    const previewAllowed =
      !session && input.productionMode !== 'required' && !first.requiresDelivery;
    const checkpointCalls = () => {
      deadline.touch();
      execution.answerCalls(message.calls!);
      ctx.db.run(
        'UPDATE messages SET calls=? WHERE id=?',
        JSON.stringify(message.calls),
        messageId,
      );
      broadcast({
        type: 'skill-progress',
        messageId,
        skillReads: message.skillReads ?? [],
        calls: message.calls!,
      });
    };
    if (extensionPlan.length) execution.phase('search', '正在准备拓展能力');
    preparing = ctx.extensions.prepare(
      user,
      extensionPlan,
      processed.messages,
      signal,
      (extensions) => {
        deadline.touch();
        message.extensions = extensions;
        execution.search(extensions);
        if (
          previewAllowed &&
          !previewTimer &&
          extensions.some((run) => run.id === 'search' && run.status === 'running')
        ) {
          previewTimer = setTimeout(() => {
            execution.phase('search', '搜索仍在进行，先回答已知部分');
            preview = answerWhileSearching(ctx, {
              user,
              modelId: input.modelId,
              effort: input.reasoningEffort,
              messages: withWorkspace(processed.messages),
              signal,
              calls: message.calls!,
              text: onText,
              progress: checkpointCalls,
            }).catch(() => {
              /* The verified answer can still finish. */
            });
          }, 5000);
        }
        ctx.db.run(
          'UPDATE messages SET extensions=? WHERE id=?',
          JSON.stringify(extensions),
          messageId,
        );
        broadcast({ type: 'extensions', messageId, extensions });
      },
      {
        // Auxiliary models see compressed history and the original current request,
        // without the current turn's private Skill / Memory reference blocks.
        contextMessages: [...processed.messages.slice(0, -1), context.at(-1)!],
        hasHistorySummary:
          processed.compression?.status === 'compressed' ||
          processed.compression?.status === 'reused',
        queryContext: () => {
          const excerpts: ProviderMessage[] = [];
          try {
            const mentioned = listWorkspaceDocuments(ctx, user.id, id).filter(
              (doc) =>
                ['document', 'handoff', 'artifact'].includes(doc.kind) &&
                (input.content.includes(doc.id) || input.content.includes(doc.name)),
            );
            for (const doc of mentioned.slice(0, 2)) {
              const revision = readWorkspaceDocument(ctx, user.id, id, doc.id, doc.version);
              const body: unknown =
                doc.kind === 'artifact' ? JSON.parse(revision.content).text : revision.content;
              if (typeof body === 'string')
                excerpts.push({
                  role: 'user',
                  content: doc.name + '\n' + body.slice(0, 4000),
                });
            }
          } catch {
            /* The original request is sufficient to plan ordinary searches. */
          }
          const summarized =
            processed.compression?.status === 'compressed' ||
            processed.compression?.status === 'reused';
          const recent = processed.messages.slice(summarized ? 1 : 0, -1).slice(-2);
          return capabilityContext(
            [
              ...(summarized ? processed.messages.slice(0, 1) : []),
              ...recent,
              { role: 'user', content: workspace.slice(0, 5000) },
              ...excerpts,
              context.at(-1)!,
            ],
            summarized,
          );
        },
        progress: deadline.touch,
      },
    );
    const prepared = await preparing;
    clearTimeout(previewTimer);
    if (
      message.extensions?.some(
        (run) =>
          run.id === 'search' &&
          run.mode === 'auto' &&
          run.status === 'error' &&
          !run.sources.length,
      )
    )
      workspaceInput.content +=
        '\nSearch was unavailable and produced no evidence for this turn. Explain which external facts remain unverified, and do not invent citations.';
    if (preview) {
      await preview;
      if (message.content) {
        prepared[prepared.length - 1] = {
          ...prepared.at(-1)!,
          content:
            prepared.at(-1)!.content +
            '\n\nPreliminary response already shown to the user: ' +
            message.content.slice(0, 2400) +
            (message.extensions?.some((run) => run.id === 'search' && run.sources.length)
              ? '\nNow supply the verification outcome and source links. Address gaps and corrections without repeating the provisional answer.'
              : '\nVerification yielded no usable evidence. Clearly identify what remains unverified. Do not supply citations or repeat the provisional answer.'),
        };
        onText('\n\n');
      }
    }
    signal.throwIfAborted();
    execution.phase(preview ? 'verify' : 'answer', preview ? '正在补充核实结果' : '正在生成回答');
    await generateReply(ctx, {
      user,
      conversationId: id,
      requestContent: input.content,
      productionMode: input.productionMode,
      modelId: input.modelId,
      messageId,
      messages: withWorkspace(prepared),
      compression: processed.compression,
      signal,
      session,
      recorder: recorder && {
        finish: recorder.finish,
        request: (request) =>
          recorder!.request({
            ...request,
            messages: request.messages.filter((message) => message !== workspaceInput),
            steps: request.steps.map((step) => {
              const workspaceCalls = new Set(
                step.calls
                  .filter((call) => call.name.startsWith('workspace_'))
                  .map((call) => call.id),
              );
              return {
                ...step,
                calls: step.calls.map((call) =>
                  workspaceCalls.has(call.id) ? { ...call, arguments: { workspace: true } } : call,
                ),
                results: step.results.map((result) =>
                  workspaceCalls.has(result.id)
                    ? { ...result, output: '[工作区文档请按当前权限查看]' }
                    : result,
                ),
              };
            }),
          }),
      },
      useWorkspace: true,
      workspaceProgress: (detail, waiting, clarification) => {
        deadline.touch();
        if (clarification) execution.state.clarification = clarification;
        if (waiting) waitingDetail = detail;
        execution.activity(detail);
      },
      takeSteering: () => {
        const notes = execution.takeSteering();
        if (notes.length) waitingDetail = undefined;
        return notes;
      },
      hasSteering: () => execution.state.steering.some((item) => !item.applied),
      effort: input.reasoningEffort,
      calls: message.calls!,
      productionProgress: () => {
        deadline.touch();
        message.artifacts = ctx.production.forMessage(user.id, messageId);
        message.productionDelivery = ctx.production.delivery(user.id, messageId);
        broadcast({
          type: 'artifacts',
          messageId,
          artifacts: message.artifacts,
          productionDelivery: message.productionDelivery,
        });
      },
      progress: (skillReads: SkillRead[], calls: ExtensionCall[]) => {
        deadline.touch();
        message.skillReads = [...skillReads];
        execution.answerCalls(calls);
        ctx.db.run(
          'UPDATE messages SET skill_reads=?,calls=? WHERE id=?',
          JSON.stringify(skillReads),
          JSON.stringify(calls),
          messageId,
        );
        broadcast({ type: 'skill-progress', messageId, skillReads, calls });
      },
      text: onText,
    });
    if (!model.toolCalling) {
      try {
        if (rememberExplicitWorkspaceNote(ctx, user.id, id, messageId, input.content)) {
          const receipt = requestedWorkspacePreference(input.content)
            ? '个人偏好已存为待纳入候选。'
            : '已写入本会话的 MEMORY.md。';
          execution.activity(receipt);
          onText('\n\n' + receipt);
        }
      } catch (error) {
        const reason = error instanceof HttpError ? error.message : '工作区写入失败';
        execution.activity('记忆未保存', 'error');
        onText('\n\n记忆未保存。' + reason);
      }
    }
  } catch (error) {
    status =
      abort.signal.aborted && !(abort.signal.reason instanceof HttpError) ? 'cancelled' : 'error';
    if (status === 'error') {
      message.error =
        deadline.signal.reason instanceof HttpError
          ? deadline.signal.reason.message
          : error instanceof HttpError
            ? error.message
            : '模型连接失败，请检查来源配置后重试';
      broadcast({
        type: 'error',
        message: message.error,
      });
    }
  } finally {
    clearTimeout(previewTimer);
    localAbort.abort();
    await Promise.allSettled([preparing, preview]);
    deadline.close();
    message.status = status;
    message.artifacts = ctx.production.forMessage(user.id, messageId);
    message.productionDelivery = ctx.production.delivery(user.id, messageId);
    message.usage = aggregateCalls(message.calls ?? []);
    const durationMs = Math.round(performance.now() - started);
    message.durationMs = durationMs;
    ctx.db.transaction(() => {
      ctx.db.run(
        'UPDATE messages SET content=?,status=?,duration_ms=?,error=? WHERE id=?',
        message.content,
        status,
        durationMs,
        message.error ?? null,
        messageId,
      );
      if (!message.calls?.some((call) => call.id === messageId))
        ctx.db.run('UPDATE usage SET status=? WHERE id=?', status, messageId);
      ctx.db.run('UPDATE conversations SET updated_at=? WHERE id=?', new Date().toISOString(), id);
    });
    if (status === 'complete') {
      if (message.productionDelivery?.decision === 'clarify') waitingDetail = '等待补充产物需求';
      const search = message.extensions?.find((run) => run.id === 'search');
      const missingEvidence =
        search &&
        (search.warning ||
          search.status === 'error' ||
          (search.status === 'complete' && !search.sources.length));
      execution.phase(
        waitingDetail ? 'waiting' : 'done',
        waitingDetail ?? (missingEvidence ? '已回答，仍有内容待核实' : '已完成'),
      );
    } else if (status === 'cancelled') execution.phase('cancelled', '已停止');
    else execution.phase('error', message.error ?? '执行中断');
    recorder?.finish(message);
    broadcast({ type: 'done', message: { ...message } });
    ctx.extensions.completeContext({
      user,
      conversationId: id,
      messageId,
      current: input.content,
      response: { ...message },
    });
  }
}
