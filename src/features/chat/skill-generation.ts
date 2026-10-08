import { randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import type { ExtensionCall, User, ReasoningEffort } from '../../shared/types';
import type { ProviderMessage, ToolStep, ToolTurn } from '../../adapters/registry';
import type { SkillSession } from '../extensions/skill-runtime';
import type { ContextRecorder } from '../extensions/context-observer';
import type { ContextCompression } from '../../shared/context';
import type { MemoryPreparation, MemoryContextRange } from '../../shared/memory';
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

export async function generateReply(
  ctx: Context,
  options: {
    user: User;
    modelId: string;
    messageId: string;
    conversationId: string;
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
  const production =
    model.toolCalling && adapter.generateTurn ? ctx.extensions.conversationTools(user) : undefined;
  const tools = [...(session?.tools() ?? []), ...(production?.tools ?? [])];
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
    throw new HttpError(500, '工具名称冲突');
  const messages = options.messages.map((message, index) =>
    index === options.messages.length - 1 && production?.tools.length
      ? { ...message, content: `${production.instructions}\n\n${message.content}` }
      : message,
  );
  for (let round = 0; round < skillLimits.rounds; round++) {
    signal.throwIfAborted();
    session?.assertActive();
    const authorized = ctx.models.authorize(user, options.modelId, 'llm');
    if (tools.length && (!authorized.toolCalling || !adapter.generateTurn))
      throw new HttpError(400, '此 Skill 包含参考文档，请选择已启用工具调用的模型');
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
        messages,
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
            messages,
            tools,
            steps,
            signal,
            options.effort,
          )
        : adapter.generate(connection, model.name, messages, signal, options.effort);
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
    if (!turn?.calls.length) return;
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
                },
                tool,
              )
            : (() => {
                throw new HttpError(403, '模型请求了未授权工具');
              })();
      results.push({ id: tool.id, output });
      options.productionProgress();
    }
    steps.push({ turn, results, text: visibleText });
    publish();
  }
  throw new HttpError(502, '已达到本轮工具调用轮数上限，已保留生成内容');
}
