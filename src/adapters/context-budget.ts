import { HttpError } from '../kernel/http';
import type { ProviderConnection, ProviderMessage } from './registry';

/** Planning estimate across tokenizers. Never persist it as provider usage. */
export function estimateInputTokens(input: unknown): number {
  let imageTokens = 0;
  const json =
    JSON.stringify(input, (_key, value) => {
      if (!value || typeof value !== 'object') return value;
      // Count native images as vision input. Base64 inside ordinary user text is still text.
      if (
        (value.type === 'input_image' && typeof value.image_url === 'string') ||
        (value.type === 'image' && value.source?.type === 'base64')
      ) {
        imageTokens += 2048;
        return '[image]';
      }
      return value;
    }) ?? '';
  // ASCII prose/code averages several bytes per token. CJK and other non-ASCII text
  // usually tokenizes more densely, so use a separate byte allowance.
  const extraUtf8Bytes = Buffer.byteLength(json) - json.length;
  return imageTokens + Math.ceil((json.length + extraUtf8Bytes * 2) / 3);
}

export function estimateMessageTokens(messages: ProviderMessage[]) {
  return estimateInputTokens(
    messages.map(({ role, content, images }) => ({
      role,
      content,
      ...(images?.length
        ? { images: images.map(() => ({ type: 'input_image', image_url: '' })) }
        : {}),
    })),
  );
}

export function availableInputTokens(window: number, outputLimit?: number | null) {
  // With no upstream output limit declared, keep a local allowance for the answer.
  const output = outputLimit ?? Math.min(8192, Math.ceil(window / 8));
  return Math.max(0, window - output);
}

export function estimateRequestTokens(body: Record<string, unknown>) {
  return estimateInputTokens({
    system: body.system,
    instructions: body.instructions,
    history: body.messages ?? body.input,
    tools: body.tools,
  });
}

/** Inspect the actual protocol payload, including dynamic tool schemas and opaque continuations. */
export function checkContextBudget(connection: ProviderConnection, body: Record<string, unknown>) {
  const window = connection.contextWindowTokens;
  if (!window) return;
  const declaredOutput = body.max_output_tokens ?? body.max_tokens;
  const budget = availableInputTokens(
    window,
    typeof declaredOutput === 'number' ? declaredOutput : connection.maxOutputTokens,
  );
  const estimated = estimateRequestTokens(body);
  if (estimated > budget)
    throw new HttpError(
      413,
      `本次请求的输入估算为 ${estimated} tokens，已超过该模型预留输出后的 ${budget} tokens。可缩短输入或工具材料、启用历史压缩，或选择容量更大的模型。`,
    );
}
