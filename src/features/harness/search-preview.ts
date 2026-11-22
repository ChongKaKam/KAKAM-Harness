import { randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import type { ProviderMessage } from '../../adapters/registry';
import type { ExtensionCall, ReasoningEffort, User } from '../../shared/types';

/** A slow evidence lookup and a short, expressly provisional answer can proceed independently. */
export async function answerWhileSearching(
  ctx: Context,
  options: {
    user: User;
    modelId: string;
    effort: ReasoningEffort;
    messages: ProviderMessage[];
    signal: AbortSignal;
    calls: ExtensionCall[];
    text: (value: string) => void;
    progress: () => void;
  },
) {
  const { user, modelId, signal, calls, progress } = options;
  if (signal.aborted) return;
  const model = ctx.models.authorize(user, modelId, 'llm');
  const connection = ctx.models.connection(model);
  const adapter = ctx.models.adapter(connection.apiMode);
  const call: ExtensionCall = {
    id: randomUUID(),
    stage: '回答 · 搜索期间的初步说明',
    modelName: model.label,
    status: 'streaming',
    usage: null,
  };
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
  progress();
  // This pass can only generate text; artifact writes and delivery checks belong to the final pass.
  const messages = options.messages.map((item, index) =>
    index === options.messages.length - 1
      ? {
          ...item,
          content:
            item.content +
            '\n\n[Search in progress] Briefly answer only independently established parts, in the user’s language. Identify what remains unverified. For an entirely time-sensitive question give only a short pending status. No citations, tool actions, or claims of completed work.',
        }
      : item,
  );
  const abort = new AbortController();
  const previewSignal = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(30_000)]);
  let length = 0;
  try {
    for await (const event of adapter.generate(
      connection,
      model.name,
      messages,
      previewSignal,
      options.effort,
    )) {
      if (event.type === 'usage') call.usage = event.usage;
      else {
        const chunk = event.text.slice(0, 2400 - length);
        length += chunk.length;
        if (chunk) options.text(chunk);
        if (length >= 2400) abort.abort();
      }
    }
    call.status = 'complete';
  } catch {
    call.status = signal.aborted || abort.signal.aborted ? 'cancelled' : 'error';
  } finally {
    ctx.db.run(
      'UPDATE usage SET status=?,input_tokens=?,output_tokens=?,total_tokens=? WHERE id=?',
      call.status,
      call.usage?.input ?? null,
      call.usage?.output ?? null,
      call.usage?.total ?? null,
      call.id,
    );
    progress();
  }
}
