import { HttpError } from '../kernel/http';
import { providerFetch, captureErrorBody } from './diagnostics';
import { unsupportedMaxEffortMessage } from './reasoning-error';
import type { ApiMode, ReasoningEffort } from '../shared/types';
import type {
  ProviderConnection,
  ProviderMessage,
  ToolDefinition,
  ToolStep,
  ToolEvent,
  ToolCall,
  ToolTurnOptions,
} from './registry';

// Provider wire objects stay opaque to chat, including reasoning/signature blocks.
type Wire = Record<string, any>;
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function argumentsOf(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new HttpError(502, '模型返回的工具参数不是完整 JSON');
  }
}
async function* frames(response: Response): AsyncIterable<Wire | '[DONE]'> {
  if (!response.body) throw new HttpError(502, '模型服务返回空响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer.trim()) buffer += '\n\n';
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        total += frame.length;
        if (frame.length > 2_000_000 || total > 8_000_000)
          throw new HttpError(502, '模型工具响应过大');
        const data = frame
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') {
          yield '[DONE]';
          continue;
        }
        try {
          yield JSON.parse(data);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, '模型流事件格式无效');
        }
      }
      if (buffer.length > 2_000_000) throw new HttpError(502, '模型流事件过大');
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function baseMessages(messages: ProviderMessage[], mode: ApiMode): Wire[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      mode === 'anthropic-messages'
        ? [
            ...(m.images ?? []).map((image) => {
              const parts = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image.data);
              if (!parts) throw new HttpError(400, '图片格式无效');
              return {
                type: 'image',
                source: { type: 'base64', media_type: parts[1], data: parts[2] },
              };
            }),
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ]
        : m.images?.length
          ? [
              { type: mode === 'responses' ? 'input_text' : 'text', text: m.content },
              ...m.images.map((image) =>
                mode === 'responses'
                  ? { type: 'input_image', image_url: image.data, detail: 'auto' }
                  : { type: 'image_url', image_url: { url: image.data } },
              ),
            ]
          : m.content,
  }));
}
export async function* generateToolTurn(
  mode: ApiMode,
  connection: ProviderConnection,
  model: string,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  steps: ToolStep[],
  signal: AbortSignal,
  effort: ReasoningEffort = 'none',
  options: ToolTurnOptions = {},
): AsyncIterable<ToolEvent> {
  const responses = mode === 'responses';
  const anthropic = mode === 'anthropic-messages';
  const history = baseMessages(messages, mode);
  for (const step of steps) {
    history.push(...(step.turn.continuation as Wire[]));
    history.push(
      ...(responses
        ? step.results.map((r) => ({
            type: 'function_call_output',
            call_id: r.id,
            output: r.output,
          }))
        : anthropic
          ? [
              {
                role: 'user',
                content: step.results.map((r) => ({
                  type: 'tool_result',
                  tool_use_id: r.id,
                  content: r.output,
                })),
              },
            ]
          : step.results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.output }))),
    );
  }
  const body: Wire = {
    model,
    stream: true,
    // Some Anthropic models reject forced tool_choice even without thinking.
    // Keep their automatic selection and enforce actual completion in the caller.
    ...(!anthropic && options.requireTool ? { tool_choice: 'required' } : {}),
    ...(responses
      ? {
          store: false,
          include: ['reasoning.encrypted_content'],
          input: history,
          tools: tools.map((t) => ({ type: 'function', ...t, strict: true })),
          ...(effort !== 'none' ? { reasoning: { effort } } : {}),
        }
      : anthropic
        ? {
            messages: history,
            max_tokens: effort === 'none' ? 4096 : 16384,
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
            ...(effort !== 'none'
              ? { thinking: { type: 'adaptive' }, output_config: { effort } }
              : {}),
          }
        : {
            messages: history,
            stream_options: { include_usage: true },
            tools: tools.map((t) => ({ type: 'function', function: { ...t, strict: true } })),
            ...(effort !== 'none' ? { reasoning_effort: effort } : {}),
          }),
  };
  const response = await providerFetch(
    connection,
    `${connection.baseUrl.replace(/\/+$/, '')}/${responses ? 'responses' : anthropic ? 'messages' : 'chat/completions'}`,
    {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(anthropic
          ? {
              'anthropic-version': '2023-06-01',
              ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : {}),
            }
          : connection.apiKey
            ? { Authorization: `Bearer ${connection.apiKey}` }
            : {}),
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const errorBody = await captureErrorBody(
      response,
      connection,
      effort === 'max' && [400, 422].includes(response.status),
    );
    throw new HttpError(
      502,
      unsupportedMaxEffortMessage(errorBody, effort) ??
        `模型工具调用返回 HTTP ${response.status}，请检查模型的工具调用支持`,
    );
  }
  const blocks = new Map<number, Wire>();
  const partialJson = new Map<number, string>();
  const completionCalls = new Map<number, Wire>();
  let text = '';
  let reasoning = '';
  let finish: string | undefined;
  let started = false;
  let usage: Wire = {};
  const complete = (): ToolEvent => {
    let continuation: Wire[];
    let calls: ToolCall[];
    if (responses) {
      continuation = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
      calls = continuation
        .filter((b) => b.type === 'function_call')
        .map((b) => ({ id: b.call_id, name: b.name, arguments: argumentsOf(b.arguments) }));
    } else if (anthropic) {
      const content = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([i, b]) =>
          b.type === 'tool_use'
            ? { ...b, input: partialJson.has(i) ? argumentsOf(partialJson.get(i)!) : b.input }
            : b,
        );
      continuation = [{ role: 'assistant', content }];
      calls = content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
    } else {
      const tool_calls = [...completionCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call);
      continuation = [
        {
          role: 'assistant',
          content: text || null,
          ...(tool_calls.length ? { tool_calls } : {}),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
        },
      ];
      calls = tool_calls.map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: argumentsOf(c.function.arguments),
      }));
    }
    if (
      calls.length > 16 ||
      new Set(calls.map((c) => c.id)).size !== calls.length ||
      calls.some((c) => typeof c.id !== 'string' || !c.id || typeof c.name !== 'string')
    )
      throw new HttpError(502, '模型返回的工具调用无效');
    if (
      anthropic &&
      (!started ||
        !['tool_use', 'end_turn', 'stop_sequence', 'refusal'].includes(finish ?? '') ||
        (finish === 'tool_use') !== !!calls.length)
    )
      throw new HttpError(502, '模型回复未正常完成，已保留生成内容');
    if (
      !anthropic &&
      !responses &&
      (finish === 'length' ||
        finish === 'content_filter' ||
        (finish === 'tool_calls') !== !!calls.length)
    )
      throw new HttpError(502, '模型工具回复未完整结束');
    return { type: 'turn', turn: { calls, continuation } };
  };
  for await (const packet of frames(response)) {
    signal.throwIfAborted();
    if (packet === '[DONE]') {
      if (anthropic || responses) throw new HttpError(502, '模型协议结束标记无效');
      yield complete();
      return;
    }
    if (!packet || typeof packet !== 'object') throw new HttpError(502, '模型流事件无效');
    const p = packet;
    if (anthropic) {
      if (p.type === 'message_start') {
        started = true;
        usage = { ...p.message?.usage };
      }
      if (p.type === 'message_delta') {
        usage = { ...usage, ...p.usage };
        finish = p.delta?.stop_reason ?? finish;
      }
      const input = usage.input_tokens,
        output = usage.output_tokens;
      const created = usage.cache_creation_input_tokens ?? 0,
        read = usage.cache_read_input_tokens ?? 0;
      if (
        (p.type === 'message_start' || p.type === 'message_delta') &&
        [input, output, created, read].every(count)
      )
        yield {
          type: 'usage',
          usage: { input: input + created + read, output, total: input + created + read + output },
        };
    } else {
      const u = responses ? p.response?.usage : p.usage;
      const input = responses ? u?.input_tokens : u?.prompt_tokens;
      const output = responses ? u?.output_tokens : u?.completion_tokens;
      if ([input, output, u?.total_tokens].every(count))
        yield { type: 'usage', usage: { input, output, total: u.total_tokens } };
    }
    if (p.error || ['error', 'response.failed', 'response.incomplete'].includes(p.type))
      throw new HttpError(
        502,
        unsupportedMaxEffortMessage(p, effort) ?? '模型工具生成中断，已保留内容和已上报用量',
      );
    if (responses) {
      if (
        ['response.output_text.delta', 'response.refusal.delta'].includes(p.type) &&
        typeof p.delta === 'string'
      )
        yield { type: 'text', text: p.delta };
      if (p.type === 'response.output_item.done') blocks.set(p.output_index, p.item);
      if (p.type === 'response.completed') {
        if (Array.isArray(p.response?.output)) {
          blocks.clear();
          p.response.output.forEach((b: Wire, i: number) => blocks.set(i, b));
        }
        yield complete();
        return;
      }
    } else if (anthropic) {
      if (p.type === 'content_block_start') {
        if (blocks.size >= 64) throw new HttpError(502, '模型返回的内容块过多');
        blocks.set(p.index, { ...p.content_block });
        if (p.content_block?.type === 'text' && p.content_block.text)
          yield { type: 'text', text: p.content_block.text };
      }
      if (p.type === 'content_block_delta') {
        const b = blocks.get(p.index);
        if (b) {
          if (p.delta?.type === 'text_delta') {
            b.text = (b.text ?? '') + p.delta.text;
            yield { type: 'text', text: p.delta.text };
          } else if (p.delta?.type === 'input_json_delta')
            partialJson.set(p.index, (partialJson.get(p.index) ?? '') + p.delta.partial_json);
          else if (p.delta?.type === 'thinking_delta')
            b.thinking = (b.thinking ?? '') + p.delta.thinking;
          else if (p.delta?.type === 'signature_delta')
            b.signature = (b.signature ?? '') + p.delta.signature;
        }
      }
      if (p.type === 'message_stop') {
        yield complete();
        return;
      }
    } else {
      const choice = p.choices?.[0];
      finish = choice?.finish_reason ?? finish;
      const delta = choice?.delta;
      if (typeof delta?.content === 'string') {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }
      if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content;
      for (const part of delta?.tool_calls ?? []) {
        if (completionCalls.size >= 16 && !completionCalls.has(part.index))
          throw new HttpError(502, '模型请求的工具过多');
        const call = completionCalls.get(part.index) ?? {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        completionCalls.set(part.index, call);
      }
    }
  }
  throw new HttpError(502, '模型连接提前结束，已保留生成内容');
}
