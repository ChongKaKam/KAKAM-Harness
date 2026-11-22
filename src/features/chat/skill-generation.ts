import { randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import type {
  ExtensionCall,
  HarnessClarification,
  User,
  ReasoningEffort,
} from '../../shared/types';
import type { ProviderMessage, ToolStep, ToolTurn } from '../../adapters/registry';
import type { SkillSession } from '../extensions/skill-runtime';
import type { ContextRecorder } from '../extensions/context-observer';
import type { ContextCompression } from '../../shared/context';
import type { MemoryPreparation, MemoryContextRange } from '../../shared/memory';
import type { ProductionMode } from '../llm-production/types';
import { skillLimits, type SkillRead } from '../skills/types';
import { HttpError } from '../../kernel/http';
import { clarificationText } from '../harness/clarification';
import { requestedWorkspacePreference } from '../harness/tools';

export function aggregateCalls(calls: ExtensionCall[]) {
  if (!calls.length || calls.some((call) => !call.usage)) return null;
  return calls.reduce(
    (sum, call) => ({
      input: sum.input + call.usage!.input,
      output: sum.output + call.usage!.output,
      total: sum.total + call.usage!.total,
    }),
    { input: 0, output: 0, total: 0 },
  );
}

export function prepareConversationTools(
  ctx: Context,
  user: User,
  modelId: string,
  content: string,
  productionMode: ProductionMode = 'auto',
) {
  const selection = ctx.extensions.conversationTools(user, content, productionMode === 'required');
  if ((selection.requirements ?? []).length) {
    const model = ctx.models.authorize(user, modelId, 'llm');
    if (
      !model.toolCalling ||
      !ctx.models.adapter(ctx.models.connection(model).apiMode).generateTurn
    )
      throw new HttpError(
        400,
        '当前聊天模型未启用工具调用，无法生成产物；请选择已启用工具调用的模型',
      );
  }
  return selection;
}

export function prepareReplyTools(
  ctx: Context,
  options: {
    user: User;
    modelId: string;
    conversationId: string;
    messageId: string;
    signal: AbortSignal;
    session?: SkillSession;
    requestContent: string;
    useWorkspace?: boolean;
    productionMode?: ProductionMode;
  },
  supportsTools: boolean,
) {
  const { user, messageId, signal, session } = options;
  const selection = prepareConversationTools(
    ctx,
    user,
    options.modelId,
    options.requestContent,
    options.productionMode,
  );
  const production = supportsTools ? selection : undefined;
  const requirementScope = {
    user,
    conversationId: options.conversationId,
    messageId,
    requestId: messageId,
    signal,
    requireDelivery: options.productionMode === 'required',
    useWorkspace: options.useWorkspace,
    requestedPreference: options.useWorkspace
      ? requestedWorkspacePreference(options.requestContent)
      : undefined,
  };
  const pending = () =>
    production?.pending?.(requirementScope) ??
    (production?.requirements ?? []).filter(
      (requirement) => !requirement.satisfied(requirementScope),
    );
  const toolInstructions = production?.tools.length ? production.instructions : '';
  const round = (messages: ProviderMessage[]) => {
    const tools = [
      ...(session?.tools() ?? []),
      ...(production?.toolsFor?.(requirementScope) ?? production?.tools ?? []),
    ];
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new HttpError(500, '工具名称冲突');
    const outstanding = pending();
    const instructions = outstanding
      .map((requirement) => requirement.instructions)
      .filter((instruction) => !production?.instructions.includes(instruction))
      .join('\n\n');
    const prefix = [instructions, toolInstructions].filter(Boolean).join('\n\n');
    const currentOffset = prefix ? prefix.length + 2 : 0;
    const roundMessages = prefix
      ? messages.map((message, index) =>
          index === messages.length - 1
            ? { ...message, content: prefix + '\n\n' + message.content }
            : message,
        )
      : messages;
    return { tools, outstanding, roundMessages, currentOffset };
  };
  return {
    production,
    requirementScope,
    pending,
    round,
    requiresDelivery: Boolean(selection.requirements?.length),
  };
}

export async function generateReply(
  ctx: Context,
  options: {
    user: User;
    modelId: string;
    messageId: string;
    conversationId: string;
    requestContent?: string;
    productionMode?: ProductionMode;
    messages: ProviderMessage[];
    effort: ReasoningEffort;
    signal: AbortSignal;
    session?: SkillSession;
    useWorkspace?: boolean;
    takeSteering?(): string[];
    hasSteering?(): boolean;
    workspaceProgress?(
      detail: string,
      waiting?: boolean,
      clarification?: HarnessClarification,
    ): void;
    recorder?: ContextRecorder;
    compression?: ContextCompression;
    memory?: MemoryPreparation;
    memoryRanges?: MemoryContextRange[];
    calls: ExtensionCall[];
    text(text: string): void;
    progress(reads: SkillRead[], calls: ExtensionCall[]): void;
    productionProgress(): void;
  },
) {
  const { user, session, calls, signal, messageId } = options;
  const steps: (ToolStep & { text: string })[] = [];
  let executedTools = 0;
  // Pin the protocol/endpoint for this turn; opaque continuation must never cross providers.
  const model = ctx.models.authorize(user, options.modelId, 'llm');
  const initialConnection = ctx.models.connection(model);
  const adapter = ctx.models.adapter(initialConnection.apiMode);
  const {
    production,
    requirementScope,
    pending,
    round: prepareRound,
  } = prepareReplyTools(
    ctx,
    {
      ...options,
      requestContent: options.requestContent ?? options.messages.at(-1)?.content ?? '',
    },
    Boolean(model.toolCalling && adapter.generateTurn),
  );
  let roundLimit = skillLimits.rounds;
  let waitingForSteering = false;
  let continuedText = false;
  const extendRounds = (requirements: ReturnType<typeof pending>) => {
    for (const requirement of requirements)
      if (requirement.maxRounds && Number.isFinite(requirement.maxRounds))
        roundLimit = Math.max(roundLimit, Math.min(skillLimits.reads, requirement.maxRounds));
  };
  for (
    let round = 0;
    round < roundLimit || (waitingForSteering && round < skillLimits.reads);
    round++
  ) {
    signal.throwIfAborted();
    session?.assertActive();
    const { tools, outstanding, roundMessages, currentOffset } = prepareRound(options.messages);
    extendRounds(outstanding);
    const memoryRanges = options.memoryRanges?.map((range) => ({
      ...range,
      start: range.start + currentOffset,
      end: range.end + currentOffset,
    }));
    const authorized = ctx.models.authorize(user, options.modelId, 'llm');
    const connection = ctx.models.connection(authorized);
    if (
      authorized.providerId !== model.providerId ||
      authorized.name !== model.name ||
      connection.baseUrl !== initialConnection.baseUrl ||
      connection.apiMode !== initialConnection.apiMode ||
      connection.apiKey !== initialConnection.apiKey
    )
      throw new HttpError(409, '本轮生成期间模型来源或凭据已变更，已停止续接。请重新发起请求。');
    if (tools.length && (!authorized.toolCalling || !adapter.generateTurn))
      throw new HttpError(400, '当前模型无法继续调用工具，请选择已启用工具调用的模型');
    // Drain only at a model boundary. A disconnected viewer never drives this loop.
    const steering = options.takeSteering?.() ?? [];
    if (waitingForSteering && !steering.length) return;
    if (steering.length) {
      if (!steps.length)
        steps.push({ text: '', turn: { calls: [], continuation: [] }, results: [] });
      steps[steps.length - 1].steering = steering;
      if (waitingForSteering) roundLimit = Math.max(roundLimit, round + 1);
    }
    waitingForSteering = false;
    const call: ExtensionCall = {
      id: round === 0 ? messageId : randomUUID(),
      stage: `回答 · 第 ${calls.length + 1} 次请求`,
      modelName: model.label,
      status: 'streaming',
      usage: null,
    };
    if (round > 0)
      ctx.db.run(
        'INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)',
        call.id,
        user.id,
        model.label,
        null,
        null,
        null,
        'streaming',
        new Date().toISOString(),
      );
    calls.push(call);
    const publish = () => options.progress(session?.reads ?? [], calls);
    publish();
    let turn: ToolTurn | undefined;
    let visibleText = '';
    try {
      options.recorder?.request({
        callId: call.id,
        messages: roundMessages,
        tools,
        steps: steps.map(({ text, turn, results, steering }) => ({
          text,
          calls: turn.calls,
          results,
          steering,
        })),
        memory: options.memory,
        memoryRanges,
        currentOffset,
        compression: options.compression,
      });
      if (round === 0 && options.memory?.operationId)
        void ctx.extensions.memoryApplied(user, options.memory.operationId);
      const events = tools.length
        ? adapter.generateTurn!(
            connection,
            model.name,
            roundMessages,
            tools,
            steps,
            signal,
            options.effort,
            { requireTool: outstanding.length > 0 },
          )
        : adapter.generate(
            connection,
            model.name,
            [
              ...roundMessages,
              ...steps.flatMap((step): ProviderMessage[] => [
                ...(step.text ? [{ role: 'assistant' as const, content: step.text }] : []),
                ...(step.steering ?? []).map((content) => ({ role: 'user' as const, content })),
              ]),
            ],
            signal,
            options.effort,
          );
      for await (const event of events) {
        signal.throwIfAborted();
        if (event.type === 'usage') call.usage = event.usage;
        else if (event.type === 'text') {
          if (continuedText && event.text) {
            options.text('\n\n');
            continuedText = false;
          }
          visibleText += event.text;
          options.text(event.text);
        } else turn = event.turn;
      }
      signal.throwIfAborted();
      if (tools.length && !turn) throw new HttpError(502, '模型工具回复未完整结束');
      call.status = 'complete';
    } catch (error) {
      call.status =
        signal.aborted && signal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'error';
      throw error;
    } finally {
      ctx.db.run(
        'UPDATE usage SET input_tokens=?,output_tokens=?,total_tokens=?,status=? WHERE id=?',
        call.usage?.input ?? null,
        call.usage?.output ?? null,
        call.usage?.total ?? null,
        call.status,
        call.id,
      );
      publish();
    }
    if (!turn?.calls.length) {
      const missing = pending()[0];
      if (missing) throw new HttpError(502, missing.failureMessage);
      if (
        !options.takeSteering ||
        options.hasSteering?.() === false ||
        round + 1 >= skillLimits.reads
      )
        return;
      steps.push({ text: visibleText, turn: turn ?? { calls: [], continuation: [] }, results: [] });
      waitingForSteering = true;
      continuedText ||= !!visibleText;
      continue;
    }
    const results: ToolStep['results'] = [];
    let clarification: HarnessClarification | undefined;
    // Validate the whole model turn before the first tool can change workspace state.
    const offered = new Set(tools.map((tool) => tool.name));
    if (turn.calls.some((tool) => !offered.has(tool.name)))
      throw new HttpError(403, '模型请求了本轮未授权工具');
    for (const tool of turn.calls) {
      signal.throwIfAborted();
      if (executedTools >= skillLimits.reads)
        throw new HttpError(502, '已达到本轮工具调用次数上限，已保留生成内容');
      executedTools++;
      const output =
        tool.name === 'skills_read' && session
          ? session.execute(tool)
          : production
            ? await production.execute({ ...requirementScope, requestId: call.id }, tool)
            : (() => {
                throw new HttpError(403, '模型请求了未授权工具');
              })();
      results.push({ id: tool.id, output });
      if (requirementScope.useWorkspace && tool.name.startsWith('workspace_')) {
        const outcome: {
          error?: string;
          question?: string;
          suggestion?: string;
          approval?: { status: string };
        } = JSON.parse(output);
        if (outcome.error) options.workspaceProgress?.(outcome.error);
        else if (tool.name === 'workspace_ask' && outcome.question) {
          clarification ??= {
            question: outcome.question,
            ...(outcome.suggestion ? { suggestion: outcome.suggestion } : {}),
          };
        } else if (outcome.approval)
          options.workspaceProgress?.(
            outcome.approval.status === 'approved'
              ? '已获准使用指定版本'
              : '已提出资料申请，请在工作区审阅',
            outcome.approval.status === 'pending',
          );
        else if (tool.name === 'workspace_write')
          options.workspaceProgress?.('已保存会话私有文档修订');
        else options.workspaceProgress?.('已读取可用的工作区资料');
      }
      options.productionProgress();
      const remaining = pending();
      extendRounds(remaining);
      const failed = remaining.find(
        (requirement) => requirement.toolName === tool.name && requirement.stopOnFailure,
      );
      if (failed) {
        let reason = failed.failureMessage;
        try {
          const result = JSON.parse(output) as { error?: unknown };
          if (typeof result.error === 'string') reason = result.error;
        } catch {
          /* Plain tool output still uses the registered safe failure message. */
        }
        throw new HttpError(502, reason);
      }
    }
    steps.push({ turn, results, text: visibleText });
    publish();
    // A general clarification is already the next user-facing action. Required deliveries
    // continue through their own validated clarify decision and cannot be bypassed here.
    if (clarification && !pending().length && !options.hasSteering?.()) {
      options.text((visibleText ? '\n\n' : '') + clarificationText(clarification));
      options.workspaceProgress?.('等待用户补充', true, clarification);
      return;
    }
  }
  throw new HttpError(502, '已达到本轮工具调用轮数上限，已保留生成内容');
}
