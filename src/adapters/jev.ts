import { z } from 'zod';
import type {
  ModelAdapter,
  ProviderConnection,
  ProviderEvent,
  DecisionEvent,
  DecisionInput,
} from './registry';
import { HttpError } from '../kernel/http';

const headers = (c: ProviderConnection) => ({
  'Content-Type': 'application/json',
  ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
});
const endpoint = (c: ProviderConnection, path: string) =>
  `${c.baseUrl.replace(/\/+$/, '')}/${path}`;
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
async function check(response: Response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(502, `Jev 服务返回 HTTP ${response.status}，请检查模型来源配置`);
  }
}
/** TypeSafe System One is a decision protocol, never a chat-completions wrapper. */
export class JevAdapter implements ModelAdapter {
  async discover(c: ProviderConnection) {
    const response = await fetch(endpoint(c, 'models'), {
      headers: headers(c),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    await check(response);
    const result = z
      .object({ models: z.array(z.object({ name: z.string().min(1) })) })
      .safeParse(await response.json());
    if (!result.success) throw new HttpError(502, 'Jev 来源未返回兼容的模型列表');
    return [...new Set(result.data.models.map((m) => m.name))].slice(0, 1000);
  }
  async *generate(): AsyncIterable<ProviderEvent> {
    throw new HttpError(400, 'Jev 是决策模型，不能作为聊天模型');
  }
  async *decide(
    c: ProviderConnection,
    model: string,
    input: DecisionInput,
    signal: AbortSignal,
  ): AsyncIterable<DecisionEvent> {
    const response = await fetch(endpoint(c, 'systemone'), {
      method: 'POST',
      headers: headers(c),
      redirect: 'error',
      signal,
      body: JSON.stringify({
        model,
        state: input.state,
        questions: {
          enabled: {
            type: 'choice',
            instructions: input.instructions,
            criteria: {
              on: 'Enable this capability for the request.',
              off: 'Do not enable this capability for the request.',
            },
          },
        },
      }),
    });
    await check(response);
    const body = await response.json();
    const usage = usageSchema.safeParse(body?.usage);
    if (usage.success) {
      const { input_tokens: input, output_tokens: output } = usage.data;
      if (Number.isSafeInteger(input + output))
        yield { type: 'usage', usage: { input, output, total: input + output } };
    }
    const answer = z
      .object({ type: z.literal('choice'), choice: z.enum(['on', 'off']) })
      .safeParse(body?.answers?.enabled);
    if (!answer.success) throw new HttpError(502, 'Jev 返回的决策格式无效');
    yield { type: 'decision', enabled: answer.data.choice === 'on' };
  }
}
