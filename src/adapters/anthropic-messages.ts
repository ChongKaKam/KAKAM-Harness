import { generateToolTurn } from './tool-turn';
import type { ToolDefinition, ToolStep, ToolTurnOptions } from './registry';
import { HttpError } from '../kernel/http';
import { providerFetch, captureErrorBody } from './diagnostics';
import { unsupportedMaxEffortMessage } from './reasoning-error';
import type { ReasoningEffort } from '../shared/types';
import type { ModelAdapter, ProviderConnection, ProviderEvent, ProviderMessage } from './registry';

const endpoint = (base: string, path: string) => `${base.replace(/\/+$/, '')}/${path}`;
const headers = (key: string) => ({
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
  ...(key ? { 'x-api-key': key } : {}),
});
async function check(
  response: Response,
  connection: ProviderConnection,
  effort: ReasoningEffort = 'none',
) {
  if (!response.ok) {
    const body = await captureErrorBody(
      response,
      connection,
      effort === 'max' && [400, 422].includes(response.status),
    );
    const maxError = unsupportedMaxEffortMessage(body, effort);
    if (maxError) throw new HttpError(502, maxError);
    throw new HttpError(
      502,
      `Anthropic 服务返回 HTTP ${response.status}，请检查地址、密钥、模型及思考程度`,
    );
  }
}
interface Event {
  type?: string;
  message?: { usage?: Record<string, unknown> };
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: Record<string, unknown>;
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export class AnthropicMessagesAdapter implements ModelAdapter {
  generateTurn(
    connection: ProviderConnection,
    model: string,
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    steps: ToolStep[],
    signal: AbortSignal,
    effort?: ReasoningEffort,
    options?: ToolTurnOptions,
  ) {
    return generateToolTurn(
      'anthropic-messages',
      connection,
      model,
      messages,
      tools,
      steps,
      signal,
      effort,
      options,
    );
  }
  async discover(connection: ProviderConnection): Promise<string[]> {
    const names = new Set<string>();
    const cursors = new Set<string>();
    const signal = AbortSignal.timeout(20_000);
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL(endpoint(connection.baseUrl, 'models'));
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after_id', after);
      const response = await providerFetch(connection, url, {
        headers: headers(connection.apiKey),
        signal,
        redirect: 'error',
      });
      await check(response, connection);
      const data = (await response.json()) as {
        data?: { id?: string }[];
        has_more?: boolean;
        last_id?: string;
      };
      if (!Array.isArray(data.data)) throw new HttpError(502, 'Anthropic 模型列表格式无效');
      for (const model of data.data)
        if (typeof model.id === 'string' && model.id) names.add(model.id);
      if (!data.has_more || names.size >= 1000) return [...names].slice(0, 1000);
      if (!data.last_id || cursors.has(data.last_id))
        throw new HttpError(502, 'Anthropic 模型列表分页无效');
      after = data.last_id;
      cursors.add(after);
    }
    return [...names].slice(0, 1000);
  }

  async *generate(
    connection: ProviderConnection,
    model: string,
    messages: ProviderMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort = 'none',
  ): AsyncIterable<ProviderEvent> {
    const response = await providerFetch(connection, endpoint(connection.baseUrl, 'messages'), {
      method: 'POST',
      headers: headers(connection.apiKey),
      signal,
      redirect: 'error',
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: effort === 'none' ? 4096 : 16384,
        ...(effort === 'none' ? {} : { thinking: { type: 'adaptive' }, output_config: { effort } }),
        messages: messages.map((message) => ({
          role: message.role,
          content: [
            ...(message.images ?? []).map((image) => {
              const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image.data);
              if (!match) throw new HttpError(400, '不支持的图片格式');
              return {
                type: 'image',
                source: { type: 'base64', media_type: match[1], data: match[2] },
              };
            }),
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ],
        })),
      }),
    });
    await check(response, connection, effort);
    if (!response.body) throw new HttpError(502, 'Anthropic 服务未返回流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;
    let receivedDelta = false;
    let stopReason: string | undefined;
    let usage: Record<string, unknown> = {};
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        // Ignore comments/unknown event types, but never accept a truncated response as complete.
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (frame.length > 2_000_000) throw new HttpError(502, 'Anthropic 流事件过大');
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          let chunk: Event;
          try {
            chunk = JSON.parse(data);
            if (!chunk || typeof chunk !== 'object') throw new Error();
          } catch {
            throw new HttpError(502, 'Anthropic 流事件格式无效');
          }
          if (chunk.type === 'error')
            throw new HttpError(
              502,
              unsupportedMaxEffortMessage(chunk, effort) ??
                'Anthropic 生成失败，请稍后重试或检查来源配置',
            );
          if (chunk.type === 'message_start') {
            started = true;
            usage = { ...chunk.message?.usage };
          } else if (
            chunk.type === 'content_block_delta' &&
            chunk.delta?.type === 'text_delta' &&
            typeof chunk.delta.text === 'string'
          ) {
            yield { type: 'text', text: chunk.delta.text };
          } else if (chunk.type === 'message_delta') {
            receivedDelta = true;
            stopReason = chunk.delta?.stop_reason ?? stopReason;
            // message_delta counts are cumulative. Merge fields; never sum repeated output counts.
            usage = { ...usage, ...chunk.usage };
            const input = usage.input_tokens;
            const output = usage.output_tokens;
            const created = usage.cache_creation_input_tokens ?? 0;
            const read = usage.cache_read_input_tokens ?? 0;
            if (
              count(input) &&
              count(output) &&
              count(created) &&
              count(read) &&
              count(input + output + created + read) &&
              count(chunk.usage?.output_tokens)
            ) {
              yield {
                type: 'usage',
                usage: {
                  input: input + created + read,
                  output,
                  total: input + created + read + output,
                },
              };
            }
          } else if (chunk.type === 'message_stop') {
            if (!started || !receivedDelta) throw new HttpError(502, 'Anthropic 回复未完整结束');
            if (stopReason === 'max_tokens')
              throw new HttpError(
                502,
                '回复达到输出上限，已保留生成内容；可降低思考程度或继续提问',
              );
            if (!['end_turn', 'stop_sequence', 'refusal'].includes(stopReason ?? ''))
              throw new HttpError(502, 'Anthropic 回复未正常完成，已保留生成内容');
            return;
          }
        }
        if (buffer.length > 2_000_000) throw new HttpError(502, 'Anthropic 流事件过大');
        if (done) throw new HttpError(502, 'Anthropic 连接提前结束，已保留生成内容');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
