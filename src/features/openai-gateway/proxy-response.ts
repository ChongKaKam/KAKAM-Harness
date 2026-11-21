import { once } from 'node:events';
import type { Response as ExpressResponse } from 'express';
import { embeddingUsage } from '../../adapters/embeddings';
import { HttpError } from '../../kernel/http';
import type { EmbeddingUsage } from '../../shared/types';

const maxPayload = 32 * 1024 * 1024;
export interface RelayResult {
  usage: EmbeddingUsage | null;
  status: 'complete' | 'error' | 'cancelled';
}

const upstreamCodes = new Set([
  'insufficient_quota',
  'rate_limit_exceeded',
  'model_not_found',
  'invalid_api_key',
  'context_length_exceeded',
  'server_error',
  'unsupported_value',
  'unsupported_parameter',
  'invalid_request_error',
  'content_policy_violation',
  'billing_hard_limit_reached',
]);
export function sdkError(status: number, message: string, providerCode?: unknown) {
  const type =
    status === 401
      ? 'authentication_error'
      : status === 403
        ? 'permission_error'
        : status === 429
          ? 'rate_limit_error'
          : status >= 500
            ? 'api_error'
            : 'invalid_request_error';
  const code =
    typeof providerCode === 'string' && upstreamCodes.has(providerCode) ? providerCode : null;
  return { error: { message, type, param: null, code } };
}

function observe(payload: Record<string, any>, result: RelayResult) {
  const usage = embeddingUsage(payload.response?.usage ?? payload.usage);
  if (usage) {
    result.usage = {
      input: usage.input ?? result.usage?.input ?? null,
      output: usage.output ?? result.usage?.output ?? null,
      total: usage.total ?? result.usage?.total ?? null,
    };
  }
}

async function readJSON(response: Response) {
  if (!response.body) throw new HttpError(502, 'OpenAI returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxPayload) throw new HttpError(502, 'OpenAI response exceeded the size limit.');
      text += decoder.decode(value, { stream: true });
    }
    const payload = JSON.parse(text + decoder.decode());
    if (!payload || Array.isArray(payload) || typeof payload !== 'object')
      throw new HttpError(502, 'OpenAI returned invalid JSON.');
    return payload as Record<string, any>;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Preserve complete event frames, including tool argument deltas and encrypted reasoning.
// Only error frames are replaced, as providers can include fragments of credentials in errors.
async function streamResponse(
  response: Response,
  res: ExpressResponse,
  result: RelayResult,
  signal: AbortSignal,
  responses: boolean,
) {
  if (!response.body) throw new HttpError(502, 'OpenAI returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  let failed = false;
  try {
    res.type('text/event-stream').set('X-Accel-Buffering', 'no').flushHeaders();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      const searchFrom = Math.max(0, buffer.length - 3);
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Large terminal events can span many network chunks. Search only the new bytes
      // and the possible split delimiter until there is a complete frame to parse.
      if (!done && !/\r?\n\r?\n/.test(buffer.slice(searchFrom))) {
        if (buffer.length > maxPayload)
          throw new HttpError(502, 'OpenAI stream event exceeded the size limit.');
        continue;
      }
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop()!;
      if (done && buffer.trim()) {
        frames.push(buffer);
        buffer = '';
      }
      if (buffer.length > maxPayload)
        throw new HttpError(502, 'OpenAI stream event exceeded the size limit.');
      for (let frame of frames) {
        if (frame.length > maxPayload)
          throw new HttpError(502, 'OpenAI stream event exceeded the size limit.');
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data.trim() === '[DONE]') terminal = !responses;
        else if (data) {
          const payload = JSON.parse(data);
          observe(payload, result);
          if (responses && payload.type === 'response.completed') terminal = true;
          if (responses && payload.type === 'response.incomplete') {
            terminal = true;
            failed = true;
          }
          if (payload.error || payload.type === 'error' || payload.type === 'response.failed') {
            failed = terminal = true;
            const error = sdkError(
              502,
              'OpenAI could not complete the request.',
              payload.error?.code ?? payload.response?.error?.code ?? payload.code,
            );
            frame = payload.type
              ? 'event: error\ndata: ' + JSON.stringify({ ...error.error, type: 'error' })
              : 'data: ' + JSON.stringify(error);
          }
        }
        const canWrite = res.write(frame + '\n\n');
        if (terminal) {
          // SDKs close after the final event. Account for it immediately instead of
          // waiting for OpenAI to close its HTTP body or the downstream socket to drain.
          result.status = failed ? 'error' : 'complete';
          res.end();
          return;
        }
        if (!canWrite) await once(res, 'drain', { signal });
      }
      if (done) break;
    }
    throw new HttpError(502, 'OpenAI closed the stream before the final event.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function relayResponse(
  response: Response,
  res: ExpressResponse,
  result: RelayResult,
  signal: AbortSignal,
  responses: boolean,
) {
  const requestId = response.headers.get('x-request-id');
  if (requestId && /^[\w.-]{1,200}$/.test(requestId)) res.set('x-request-id', requestId);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok) {
    // Never reflect the provider error message. In particular, invalid-key errors echo the key.
    let code: unknown;
    if (contentType === 'application/json') {
      try {
        const payload = await readJSON(response);
        observe(payload, result);
        code = payload.error?.code;
      } catch {
        /* retain upstream HTTP status */
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
    const status = response.status >= 400 ? response.status : 502;
    const retry = response.headers.get('retry-after');
    if (retry && /^\d{1,9}$/.test(retry)) res.set('Retry-After', retry);
    res
      .status(status)
      .json(sdkError(status, `OpenAI rejected the request (HTTP ${status}).`, code));
    return;
  }
  res.status(response.status);
  if (contentType === 'text/event-stream')
    return streamResponse(response, res, result, signal, responses);
  if (contentType !== 'application/json') {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(502, 'OpenAI returned an unsupported response type.');
  }
  const payload = await readJSON(response);
  observe(payload, result);
  if (payload.error || payload.status === 'failed')
    throw new HttpError(502, 'OpenAI could not complete the request.');
  result.status = payload.status === 'incomplete' ? 'error' : 'complete';
  res.json(payload);
}
