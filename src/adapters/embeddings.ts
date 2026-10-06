import { HttpError } from '../kernel/http';
import type { EmbeddingResult, EmbeddingUsage } from '../shared/types';

/** Retain reported billing fields even if the provider's vectors fail validation. */
export class EmbeddingError extends HttpError {
  constructor(
    message: string,
    readonly usage: EmbeddingUsage | null = null,
    readonly dimensions: number | null = null,
  ) {
    super(502, message);
  }
}
export function embeddingUsage(raw: unknown): EmbeddingUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const reported = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  const result = {
    input: reported(value.prompt_tokens ?? value.input_tokens),
    output: reported(value.completion_tokens ?? value.output_tokens),
    total: reported(value.total_tokens),
  };
  return Object.values(result).some((n) => n !== null) ? result : null;
}
export function validateEmbeddingResponse(
  data: unknown,
  count: number,
  usage: EmbeddingUsage | null,
  expectedDimensions?: number,
): EmbeddingResult {
  if (!Array.isArray(data) || data.length !== count)
    throw new EmbeddingError('Embedding 服务返回的向量数量与输入不一致', usage);
  const vectors: number[][] = new Array(count);
  let dimensions: number | null = null;
  for (const item of data) {
    if (
      !item ||
      !Number.isSafeInteger(item.index) ||
      item.index < 0 ||
      item.index >= count ||
      vectors[item.index]
    )
      throw new EmbeddingError('Embedding 服务返回无效或重复的向量 index', usage, dimensions);
    const vector = item.embedding;
    if (!Array.isArray(vector) || vector.length < 1 || vector.length > 16000)
      throw new EmbeddingError('Embedding 服务返回无效的向量维度', usage, dimensions);
    dimensions ??= vector.length;
    if (vector.length !== dimensions)
      throw new EmbeddingError('Embedding 服务返回的向量维度不一致', usage, dimensions);
    if (
      vector.some(
        (n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 3.4028234663852886e38,
      )
    )
      throw new EmbeddingError(
        'Embedding 服务返回非有限值或超出 pgvector 范围的数值',
        usage,
        dimensions,
      );
    if (!vector.some((n) => Math.fround(n) !== 0))
      throw new EmbeddingError('Embedding 服务返回零向量，无法执行余弦检索', usage, dimensions);
    vectors[item.index] = vector;
  }
  if (expectedDimensions !== undefined && expectedDimensions !== dimensions)
    throw new EmbeddingError(
      `Embedding 实际维度 ${dimensions} 与配置维度 ${expectedDimensions} 不一致`,
      usage,
      dimensions,
    );
  return { vectors, dimensions: dimensions!, usage };
}

export async function readEmbeddingBody(response: Response) {
  if (!response.body) throw new EmbeddingError('Embedding 服务返回空响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new EmbeddingError('Embedding 响应超过大小限制');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new EmbeddingError('Embedding 服务未返回有效对象');
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new EmbeddingError('Embedding 服务未返回有效 JSON');
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
