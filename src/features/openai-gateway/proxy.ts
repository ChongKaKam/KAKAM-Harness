import { randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import { Router, type Response, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { HttpError } from '../../kernel/http';
import type { Model } from '../../shared/types';
import { isOpenAIProvider, resolveGatewayKey } from './keys';
import { relayResponse, sdkError, type RelayResult } from './proxy-response';

const prefix = '/openai/v1';
const generation = z.looseObject({
  model: z.string().min(1).max(200),
  stream: z.boolean().optional(),
  store: z.literal(false).nullish(),
  background: z.literal(false).nullish(),
  previous_response_id: z.null().optional(),
  conversation: z.null().optional(),
  prompt: z.null().optional(),
  tools: z.array(z.record(z.string(), z.unknown())).nullish(),
  stream_options: z.record(z.string(), z.unknown()).nullish(),
  max_output_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  max_tokens: z.number().int().positive().nullish(),
});
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// These tool declarations run on the client or perform public web searches. Resource-backed
// tools (e.g. file search and container execution) would share the upstream project namespace.
const safeTools = new Set([
  'function',
  'custom',
  'apply_patch',
  'local_shell',
  'web_search',
  'web_search_preview',
]);
function validateTools(tools: unknown) {
  if (!Array.isArray(tools)) throw new HttpError(400, 'Expected an array of tools.');
  for (const tool of tools) {
    if (!isObject(tool)) throw new HttpError(400, 'Invalid tool definition.');
    if (tool.type === 'namespace') validateTools(tool.tools);
    else if (tool.type === 'tool_search' && tool.execution === 'client') continue;
    else if (
      tool.type === 'shell' &&
      isObject(tool.environment) &&
      tool.environment.type === 'local'
    )
      continue;
    else if (!safeTools.has(String(tool.type)))
      throw new HttpError(400, 'This tool is unavailable through the gateway.');
  }
}

function validateContent(parts: unknown, vision: boolean) {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (!isObject(part)) continue;
    if (!vision && (part.type === 'image_url' || part.type === 'input_image'))
      throw new HttpError(400, 'Enable image input for this model in Drift Space.');
    if (part.file_id != null || (isObject(part.file) && part.file.file_id != null))
      throw new HttpError(400, 'Send inline content instead of an OpenAI project file ID.');
  }
}

const replayItems = new Set([
  'message',
  'reasoning',
  'compaction',
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
  'apply_patch_call',
  'apply_patch_call_output',
  'local_shell_call',
  'local_shell_call_output',
  'shell_call',
  'shell_call_output',
  'tool_search_call',
  'tool_search_output',
  'web_search_call',
]);
function validateInput(input: unknown, responses: boolean, model: Model) {
  if (responses && typeof input === 'string') return;
  if (!Array.isArray(input))
    throw new HttpError(400, responses ? 'Provide input.' : 'Provide messages.');
  for (const item of input) {
    if (!isObject(item)) throw new HttpError(400, 'Invalid input item.');
    const type = item.type ?? 'message';
    if (
      responses &&
      (!replayItems.has(String(type)) || (type === 'message' && item.content == null))
    )
      throw new HttpError(
        400,
        'Send full message and tool history instead of stored item references.',
      );
    if (
      responses &&
      (type === 'reasoning' || type === 'compaction') &&
      item.id &&
      !item.encrypted_content
    )
      throw new HttpError(
        400,
        'Replay reasoning or compaction items with their encrypted content.',
      );
    if (isObject(item.audio) && item.audio.id != null)
      throw new HttpError(400, 'Stored audio references are unavailable through the gateway.');
    if (
      !model.toolCalling &&
      ((type !== 'message' && type !== 'reasoning' && type !== 'compaction') ||
        ['tool', 'function'].includes(String(item.role)) ||
        item.tool_calls != null ||
        item.function_call != null)
    )
      throw new HttpError(400, 'Enable tool calling for this model in Drift Space.');
    if (type === 'tool_search_output') validateTools(item.tools);
    validateContent(item.content, model.vision);
    validateContent(item.output, model.vision);
  }
}

function handleError(error: unknown, res: Response) {
  if (res.destroyed || res.writableEnded) return;
  const status = error instanceof HttpError ? error.status : 502;
  const message =
    error instanceof HttpError ? error.message : 'Could not complete the OpenAI request.';
  if (res.headersSent) {
    // No successful terminal event is emitted for a broken stream.
    const body = sdkError(status, message);
    res.end(
      'event: error\ndata: ' + JSON.stringify({ ...body.error, type: 'error', ...body }) + '\n\n',
    );
  } else res.status(status).json(sdkError(status, message));
}

export function createProxyRouter(
  ctx: Context,
  options: { fetch?: typeof fetch; maxConcurrentRequests?: number } = {},
) {
  const router = Router();
  const active = new Map<AbortController, { userId: string; finished: Promise<void> }>();
  let stopping = false;
  const db = ctx.db;
  const stop = async () => {
    stopping = true;
    const runs = [...active];
    for (const [controller] of runs) controller.abort(new HttpError(503, 'Gateway stopped.'));
    await Promise.allSettled(runs.map(([, run]) => run.finished));
  };
  ctx.effect(() => ctx.kernel.onShutdown(stop));
  ctx.on('dispose', stop);

  router.use(prefix, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (stopping) throw new HttpError(503, 'Gateway stopped.');
    const identity = resolveGatewayKey(ctx, req.get('authorization'));
    const connection = ctx.models.connection(identity.providerId);
    if (!isOpenAIProvider(connection.baseUrl, connection.apiMode) || !connection.apiKey)
      throw new HttpError(503, 'The OpenAI source is unavailable.');
    res.locals.gateway = identity;
    res.locals.connection = connection;
    next();
  });
  router.get(prefix + '/models', (_req, res) => {
    const { user, providerId } = res.locals.gateway as ReturnType<typeof resolveGatewayKey>;
    const models = ctx.models
      .list(user)
      .filter((m) => m.providerId === providerId && m.kind === 'llm');
    res.json({
      object: 'list',
      data: models.map((m) => ({ id: m.name, object: 'model', created: 0, owned_by: 'openai' })),
    });
  });
  router.post([prefix + '/responses', prefix + '/chat/completions'], async (req, res) => {
    const { user, providerId } = res.locals.gateway as ReturnType<typeof resolveGatewayKey>;
    const parsed = generation.safeParse(req.body);
    if (!parsed.success)
      throw new HttpError(400, 'Invalid generation request or unsupported server-side state.');
    const body = parsed.data;
    const responses = req.path.toLowerCase().replace(/\/$/, '').endsWith('/responses');
    const model = ctx.models
      .list(user)
      .find((m) => m.providerId === providerId && m.kind === 'llm' && m.name === body.model);
    if (!model) throw new HttpError(403, 'This model is unavailable for the gateway key.');
    ctx.models.authorize(user, model.id, 'llm');
    validateInput(responses ? body.input : body.messages, responses, model);
    if (
      !model.toolCalling &&
      (body.tools?.length || body.functions != null || body.web_search_options != null)
    )
      throw new HttpError(400, 'Enable tool calling for this model in Drift Space.');
    if (body.tools) validateTools(body.tools);
    body.store = false;
    if (!responses && body.stream)
      body.stream_options = { ...body.stream_options, include_usage: true };
    const connection = res.locals.connection;
    if (
      [...active.values()].filter((run) => run.userId === user.id).length >=
      (options.maxConcurrentRequests ?? 5)
    )
      throw new HttpError(429, 'Too many concurrent gateway requests.');

    const controller = new AbortController();
    const timeout = AbortSignal.timeout(10 * 60_000);
    const signal = AbortSignal.any([controller.signal, timeout]);
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', disconnect);
    const result: RelayResult = { usage: null, cachedInputTokens: null, status: 'error' };
    const forward = async () => {
      const startedAt = performance.now();
      const markAborted = () => {
        result.endedAt ??= performance.now();
      };
      signal.addEventListener('abort', markAborted, { once: true });
      try {
        const upstream = await (options.fetch ?? fetch)(
          'https://api.openai.com/v1/' + (responses ? 'responses' : 'chat/completions'),
          {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + connection.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            redirect: 'error',
            signal,
          },
        );
        await relayResponse(upstream, res, result, signal, responses);
      } catch (error) {
        if (controller.signal.aborted) result.status = 'cancelled';
        handleError(
          timeout.aborted
            ? new HttpError(504, 'OpenAI request timed out.')
            : (controller.signal.reason ?? error),
          res,
        );
      } finally {
        const durationMs = Math.round((result.endedAt ?? performance.now()) - startedAt);
        signal.removeEventListener('abort', markAborted);
        res.off('close', disconnect);
        active.delete(controller);
        const usageId = randomUUID();
        const input = result.usage?.input ?? null;
        const cached = result.cachedInputTokens;
        db.transaction(() => {
          db.run(
            'INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)',
            usageId,
            user.id,
            '[OpenAI Gateway] ' + model.name,
            input,
            result.usage?.output ?? null,
            result.usage?.total ?? null,
            result.status,
            new Date().toISOString(),
          );
          db.run(
            'INSERT INTO openai_gateway_metrics(usage_id,cached_input_tokens,duration_ms) VALUES(?,?,?)',
            usageId,
            cached !== null && input !== null && cached > input ? null : cached,
            durationMs,
          );
        });
      }
    };
    const finished = Promise.resolve().then(forward);
    active.set(controller, { userId: user.id, finished });
    await finished;
  });
  router.use(prefix, (_req, res) =>
    res.status(404).json(sdkError(404, 'Unknown gateway endpoint.')),
  );
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => handleError(error, res);
  router.use(prefix, errorHandler);
  return router;
}
