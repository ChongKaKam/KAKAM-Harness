import { generationRequest } from './generation-request';
import { HttpError } from '../kernel/http';
import { providerFetch, captureErrorBody } from './diagnostics';
import { unsupportedMaxEffortMessage } from './reasoning-error';
import type { LlmApiMode, ReasoningEffort } from '../shared/types';
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
async function* frames(response: Response): AsyncIterable<Wire> {
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
export async function* generateToolTurn(
  mode: LlmApiMode,
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
  const body = generationRequest(mode, connection, model, messages, effort, {
    tools,
    steps,
    requireTool: options.requireTool,
  });
  const response = await providerFetch(
    connection,
    `${connection.baseUrl.replace(/\/+$/, '')}/${responses ? 'responses' : 'messages'}`,
    {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(!responses
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
    } else {
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
    }
    if (
      calls.length > 16 ||
      new Set(calls.map((c) => c.id)).size !== calls.length ||
      calls.some((c) => typeof c.id !== 'string' || !c.id || typeof c.name !== 'string')
    )
      throw new HttpError(502, '模型返回的工具调用无效');
    if (
      !responses &&
      (!started ||
        !['tool_use', 'end_turn', 'stop_sequence', 'refusal'].includes(finish ?? '') ||
        (finish === 'tool_use') !== !!calls.length)
    )
      throw new HttpError(502, '模型回复未正常完成，已保留生成内容');
    return { type: 'turn', turn: { calls, continuation } };
  };
  for await (const p of frames(response)) {
    signal.throwIfAborted();
    if (!p || (typeof p.type !== 'string' && !p.error)) throw new HttpError(502, '模型流事件无效');
    if (!responses) {
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
      const u = p.response?.usage;
      const input = u?.input_tokens;
      const output = u?.output_tokens;
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
    } else {
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
    }
  }
  throw new HttpError(502, '模型连接提前结束，已保留生成内容');
}
