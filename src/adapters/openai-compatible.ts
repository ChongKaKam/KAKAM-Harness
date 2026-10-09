import { generateToolTurn } from './tool-turn';
import type { ToolDefinition, ToolStep, ToolTurnOptions } from './registry';
import type { ModelAdapter, ProviderConnection, ProviderMessage, ProviderEvent } from './registry';
import type { ReasoningEffort } from '../shared/types';
import { HttpError } from '../kernel/http';
import { providerFetch, captureErrorBody } from './diagnostics';
import { unsupportedMaxEffortMessage } from './reasoning-error';
import { generateCompatibleImage } from './images';
import {
  EmbeddingError,
  embeddingUsage,
  readEmbeddingBody,
  validateEmbeddingResponse,
} from './embeddings';
const endpoint = (c: ProviderConnection, path: string) =>
  `${c.baseUrl.replace(/\/+$/, '')}/${path}`;
const headers = (c: ProviderConnection) => ({
  'Content-Type': 'application/json',
  ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
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
      `模型服务返回 HTTP ${response.status}，请检查来源地址、密钥和模型名称`,
    );
  }
}
export class OpenAICompatibleAdapter implements ModelAdapter {
  generateImage(c: ProviderConnection, model: string, prompt: string, signal: AbortSignal) {
    return generateCompatibleImage(c, model, prompt, signal);
  }
  async embed(
    c: ProviderConnection,
    model: string,
    inputs: string[],
    signal: AbortSignal,
    dimensions?: number,
  ) {
    if (c.apiMode && !['chat-completions', 'responses'].includes(c.apiMode))
      throw new HttpError(400, '此来源协议不支持 Embedding');
    const response = await providerFetch(c, endpoint(c, 'embeddings'), {
      method: 'POST',
      headers: headers(c),
      redirect: 'error',
      signal,
      body: JSON.stringify({
        model,
        input: inputs,
        encoding_format: 'float',
        ...(dimensions !== undefined ? { dimensions } : {}),
      }),
    });
    const body = await readEmbeddingBody(response);
    const usage = embeddingUsage(body.usage);
    if (!response.ok)
      throw new EmbeddingError(
        `Embedding 服务返回 HTTP ${response.status}，请检查来源地址、密钥和模型名称`,
        usage,
      );
    return validateEmbeddingResponse(body.data, inputs.length, usage, dimensions);
  }
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
      connection.apiMode ?? 'chat-completions',
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
  async discover(c: ProviderConnection) {
    const response = await providerFetch(c, endpoint(c, 'models'), {
      headers: headers(c),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    await check(response, c);
    const body = (await response.json()) as { data?: { id: string }[] };
    if (!Array.isArray(body.data))
      throw new HttpError(502, '来源未返回兼容的模型列表，请手动添加模型');
    return [...new Set(body.data.filter((m) => typeof m.id === 'string').map((m) => m.id))].slice(
      0,
      1000,
    );
  }
  async *generate(
    c: ProviderConnection,
    model: string,
    messages: ProviderMessage[],
    signal: AbortSignal,
    effort: ReasoningEffort = 'none',
  ): AsyncIterable<ProviderEvent> {
    const responses = c.apiMode === 'responses';
    const body = responses
      ? {
          model,
          stream: true,
          store: false,
          ...(effort !== 'none' ? { reasoning: { effort } } : {}),
          input: messages.map((m) => ({
            role: m.role,
            content: m.images?.length
              ? [
                  { type: 'input_text', text: m.content },
                  ...m.images.map((i) => ({
                    type: 'input_image',
                    image_url: i.data,
                    detail: 'auto',
                  })),
                ]
              : m.content,
          })),
        }
      : {
          model,
          stream: true,
          stream_options: { include_usage: true },
          ...(effort !== 'none' ? { reasoning_effort: effort } : {}),
          messages: messages.map((m) => ({
            role: m.role,
            content: m.images?.length
              ? [
                  { type: 'text', text: m.content },
                  ...m.images.map((i) => ({ type: 'image_url', image_url: { url: i.data } })),
                ]
              : m.content,
          })),
        };
    const response = await providerFetch(
      c,
      endpoint(c, responses ? 'responses' : 'chat/completions'),
      {
        method: 'POST',
        headers: headers(c),
        redirect: 'error',
        signal,
        body: JSON.stringify(body),
      },
    );
    await check(response, c, effort);
    if (!response.body) throw new HttpError(502, '模型服务返回空响应');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let ended = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        if (done && buffer.trim()) buffer += '\n\n';
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          if (data === '[DONE]' && !responses) {
            ended = true;
            return;
          }
          const chunk = JSON.parse(data);
          const usage = responses ? chunk.response?.usage : chunk.usage;
          const input = responses ? usage?.input_tokens : usage?.prompt_tokens;
          const output = responses ? usage?.output_tokens : usage?.completion_tokens;
          if ([input, output, usage?.total_tokens].every((n) => Number.isSafeInteger(n) && n >= 0))
            yield { type: 'usage', usage: { input, output, total: usage.total_tokens } };
          if (chunk.error || chunk.type === 'error' || chunk.type === 'response.failed')
            throw new HttpError(
              502,
              unsupportedMaxEffortMessage(chunk, effort) ??
                '模型服务中断了回复，请检查来源配置、模型及思考等级后重试',
            );
          if (chunk.type === 'response.incomplete')
            throw new HttpError(502, '模型回复未完成，已保留收到的内容');
          const text = responses
            ? ['response.output_text.delta', 'response.refusal.delta'].includes(chunk.type)
              ? chunk.delta
              : undefined
            : chunk.choices?.[0]?.delta?.content;
          if (typeof text === 'string') yield { type: 'text', text };
          if (responses && chunk.type === 'response.completed') {
            ended = true;
            return;
          }
        }
        if (buffer.length > 2_000_000) throw new HttpError(502, '模型响应片段过大');
        if (done) break;
      }
      if (!ended) throw new HttpError(502, '模型连接提前结束，已保留收到的内容');
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
