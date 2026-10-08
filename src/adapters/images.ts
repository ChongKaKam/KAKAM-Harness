import { HttpError } from '../kernel/http';
import { embeddingUsage } from './embeddings';
import { providerFetch } from './diagnostics';
import type { ImageGenerationResult, ProviderConnection } from './registry';
import type { EmbeddingUsage } from '../shared/types';

const maxImageBytes = 20 * 1024 * 1024;
const maxResponseBytes = Math.ceil((maxImageBytes * 4) / 3) + 128 * 1024;

/** Preserve real usage even when the provider returns an invalid image or an HTTP error. */
export class ImageGenerationError extends HttpError {
  constructor(
    message: string,
    readonly usage: EmbeddingUsage | null = null,
  ) {
    super(502, message);
  }
}

export function imageMimeType(data: Uint8Array): ImageGenerationResult['mimeType'] | null {
  const bytes = Buffer.from(data);
  if (bytes.length < 12 || bytes.length > maxImageBytes) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return 'image/webp';
  return null;
}

async function readImageBody(response: Response) {
  if (!response.body) throw new ImageGenerationError('图片服务返回空响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new ImageGenerationError('图片响应超过 20 MiB 文件限制');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ImageGenerationError('图片服务未返回有效对象');
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new ImageGenerationError('图片服务未返回有效 JSON');
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** A single native Images request, accepting raster bytes only. Upstream URLs are never fetched. */
export async function generateCompatibleImage(
  connection: ProviderConnection,
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<ImageGenerationResult> {
  if (connection.apiMode && !['chat-completions', 'responses'].includes(connection.apiMode))
    throw new HttpError(400, '图片生成仅支持 OpenAI-compatible 来源');
  const gptImage = /(?:^|\/)gpt-image(?:-|$)/i.test(model);
  const response = await providerFetch(
    connection,
    `${connection.baseUrl.replace(/\/+$/, '')}/images/generations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      },
      redirect: 'error',
      signal,
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        // GPT Image always returns base64 and does not accept response_format.
        ...(gptImage ? { output_format: 'png' } : { response_format: 'b64_json' }),
      }),
    },
  );
  const body = await readImageBody(response);
  const usage = embeddingUsage(body.usage);
  if (!response.ok)
    throw new ImageGenerationError(
      `图片服务返回 HTTP ${response.status}，请检查来源地址、密钥和图片模型名称`,
      usage,
    );
  const data = body.data;
  if (!Array.isArray(data) || data.length !== 1)
    throw new ImageGenerationError('图片服务必须返回一张图片', usage);
  const encoded = data[0]?.b64_json;
  if (
    typeof encoded !== 'string' ||
    !encoded.length ||
    encoded.length > Math.ceil(maxImageBytes / 3) * 4 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    throw new ImageGenerationError(
      '图片服务未返回有效的 Base64 图片；仅支持直接返回图片内容',
      usage,
    );
  const bytes = Buffer.from(encoded, 'base64');
  const mimeType = imageMimeType(bytes);
  if (!mimeType)
    throw new ImageGenerationError(
      '图片服务返回无效、过大或不支持的 PNG / JPEG / WebP 文件',
      usage,
    );
  return { data: bytes, mimeType, usage };
}
