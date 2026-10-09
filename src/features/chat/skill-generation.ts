import { randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import type { ExtensionCall, User, ReasoningEffort } from '../../shared/types';
import type { ProviderMessage, ToolStep, ToolTurn } from '../../adapters/registry';
import type { SkillSession } from '../extensions/skill-runtime';
import type { ContextRecorder } from '../extensions/context-observer';
import type { ContextCompression } from '../../shared/context';
import type { MemoryPreparation, MemoryContextRange } from '../../shared/memory';
import type { ProductionMode } from '../llm-production/types';
import { skillLimits, type SkillRead } from '../skills/types';
import { HttpError } from '../../kernel/http';

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
      !ctx.models.adapter(ctx.models.connection(model.providerId).apiMode).generateTurn
    )
      throw new HttpError(
        400,
        '当前聊天模型未启用工具调用，无法生成产物；请选择已启用工具调用的模型',
      );
  }
  return selection;
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
  const connection = ctx.models.connection(model.providerId);
  const adapter = ctx.models.adapter(connection.apiMode);
  const selection = prepareConversationTools(
    ctx,
    user,
    options.modelId,
    options.requestContent ?? options.messages.at(-1)?.content ?? '',
    options.productionMode,
  );
  const production = model.toolCalling && adapter.generateTurn ? selection : undefined;
  const requirementScope = {
    user,
    conversationId: options.conversationId,
    messageId,
    requestId: messageId,
    signal,
    requireDelivery: options.productionMode === 'required',
  };
  const pending = () =>
    production?.pending?.(requirementScope) ??
    (production?.requirements ?? []).filter(
      (requirement) => !requirement.satisfied(requirementScope),
    );
  const messages = options.messages.map((message, index) =>
    index === options.messages.length - 1 && production?.tools.length
      ? { ...message, content: `${production.instructions}\n\n${message.content}` }
      : message,
  );
  let roundLimit = skillLimits.rounds;
  const extendRounds = (requirements: ReturnType<typeof pending>) => {
    for (const requirement of requirements)
      if (requirement.maxRounds && Number.isFinite(requirement.maxRounds))
        roundLimit = Math.max(roundLimit, Math.min(skillLimits.reads, requirement.maxRounds));
  };
  for (let round = 0; round < roundLimit; round++) {
    signal.throwIfAborted();
    session?.assertActive();
    const tools = [
      ...(session?.tools() ?? []),
      ...(production?.toolsFor?.(requirementScope) ?? production?.tools ?? []),
    ];
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new HttpError(500, '工具名称冲突');
    const outstanding = pending();
    extendRounds(outstanding);
    const instructions = outstanding
      .map((requirement) => requirement.instructions)
      .filter((instruction) => !production?.instructions.includes(instruction))
      .join('\n\n');
    const roundMessages = instructions
      ? messages.map((message, index) =>
          index === messages.length - 1
            ? { ...message, content: `${instructions}\n\n${message.content}` }
            : message,
        )
      : messages;
    const authorized = ctx.models.authorize(user, options.modelId, 'llm');
    if (tools.length && (!authorized.toolCalling || !adapter.generateTurn))
      throw new HttpError(400, '当前模型无法继续调用工具，请选择已启用工具调用的模型');
    const call: ExtensionCall = {
      id: round === 0 ? messageId : randomUUID(),
      stage: `回答 · 第 ${round + 1} 次请求`,
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
        steps: steps.map(({ text, turn, results }) => ({ text, calls: turn.calls, results })),
        memory: options.memory,
        memoryRanges: options.memoryRanges,
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
        : adapter.generate(connection, model.name, roundMessages, signal, options.effort);
      for await (const event of events) {
        signal.throwIfAborted();
        if (event.type === 'usage') call.usage = event.usage;
        else if (event.type === 'text') {
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
      return;
    }
    const results: ToolStep['results'] = [];
    for (const tool of turn.calls) {
      signal.throwIfAborted();
      if (executedTools >= skillLimits.reads)
        throw new HttpError(502, '已达到本轮工具调用次数上限，已保留生成内容');
      executedTools++;
      const output =
        tool.name === 'skills_read' && session
          ? session.execute(tool)
          : production
            ? await production.execute(
                {
                  user,
                  conversationId: options.conversationId,
                  messageId,
                  requestId: call.id,
                  signal,
                  requireDelivery: requirementScope.requireDelivery,
                },
                tool,
              )
            : (() => {
                throw new HttpError(403, '模型请求了未授权工具');
              })();
      results.push({ id: tool.id, output });
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
  }
  throw new HttpError(502, '已达到本轮工具调用轮数上限，已保留生成内容');
}
