import type { ModelAdapter, ProviderConnection } from '../../adapters/registry';
import { HttpError } from '../../kernel/http';
import type { ModelConnectionTest, ReasoningEffort } from '../../shared/types';

/** Probe the same streaming path as chat, without persisting a conversation. */
export async function testModelConnection(
  adapter: ModelAdapter,
  connection: ProviderConnection,
  model: string,
  effort: ReasoningEffort,
  signal = AbortSignal.timeout(60_000),
): Promise<ModelConnectionTest> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const result: ModelConnectionTest = {
    ok: false,
    model,
    apiMode: connection.apiMode ?? 'chat-completions',
    reasoningEffort: effort,
    firstTextMs: null,
    latencyMs: 0,
    textChunks: 0,
    usage: null,
  };
  try {
    for await (const chunk of adapter.generate(
      connection,
      model,
      [{ role: 'user', content: 'Reply with only OK.' }],
      signal,
      effort,
    )) {
      if (chunk.type === 'usage') result.usage = chunk.usage;
      else if (chunk.text.length) {
        result.textChunks++;
        if (chunk.text.trim() && result.firstTextMs === null) result.firstTextMs = elapsed();
      }
    }
    if (result.firstTextMs === null)
      result.error = '请求已结束，但未收到可显示的文本，请检查来源的流式协议兼容性。';
    else result.ok = true;
  } catch (error) {
    result.error = signal.aborted
      ? '连接测试超时，请降低思考程度或检查上游响应。'
      : error instanceof HttpError
        ? error.message
        : '连接测试失败，请检查来源地址、密钥、模型及响应模式。';
  }
  result.latencyMs = elapsed();
  return result;
}
