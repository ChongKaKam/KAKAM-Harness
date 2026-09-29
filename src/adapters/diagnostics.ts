import type { ModelDiagnosticLog } from '../shared/types';
import type { ProviderConnection } from './registry';

const limit = 32_768;
const sensitive = /authorization|api[-_]?key|token|secret|password|cookie/i;

/** Only instantiated for an explicit administrator probe. Never persisted or sent to console. */
export class ProviderDiagnostics {
  private log: ModelDiagnosticLog = { output: '', truncated: false };
  private responseBody = '';
  private output = '';
  private decoder = new TextDecoder();
  private secrets: string[];
  constructor(connection: ProviderConnection) {
    const url = URL.parse(connection.baseUrl);
    this.secrets = [
      ...new Set(
        [connection.apiKey, url?.username, url?.password, ...(url?.searchParams.values() ?? [])]
          .filter((value): value is string => !!value)
          .flatMap((value) => [
            value,
            encodeURIComponent(value),
            JSON.stringify(value).slice(1, -1),
          ]),
      ),
    ].sort((a, b) => b.length - a.length);
  }
  private redact(text: string) {
    for (const secret of this.secrets) {
      text = text.split(secret).join('[REDACTED]');
      // A bounded response may end midway through a credential, including across SSE chunks.
      for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
        if (text.endsWith(secret.slice(0, n))) {
          text = text.slice(0, -n) + '[REDACTED]';
          break;
        }
      }
    }
    return text
      .replace(
        /("(?:authorization|api[-_]?key|[\w-]*token|[\w-]*secret|password|cookie)"\s*:\s*")[^"\r\n]*("|$)/gi,
        '$1[REDACTED]$2',
      )
      .replace(/\bBearer\s+[^\s",}]+/gi, 'Bearer [REDACTED]');
  }
  private bounded(text: string) {
    if (text.length > limit) this.log.truncated = true;
    return this.redact(text.slice(0, limit));
  }
  request(url: string | URL, init: RequestInit) {
    const safe = new URL(url);
    safe.username = '';
    safe.password = '';
    safe.hash = '';
    for (const key of [...safe.searchParams.keys()]) safe.searchParams.set(key, '[REDACTED]');
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = sensitive.test(key) ? '[REDACTED]' : this.bounded(value);
    });
    this.log.request = {
      method: init.method ?? 'GET',
      url: this.redact(safe.toString()),
      headers,
      body: this.bounded(typeof init.body === 'string' ? init.body : ''),
    };
  }
  response(response: Response) {
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'x-request-id', 'request-id', 'retry-after']) {
      const value = response.headers.get(name);
      if (value) headers[name] = this.bounded(value);
    }
    this.log.response = { status: response.status, headers, body: '' };
  }
  chunk(chunk: Uint8Array) {
    this.responseBody = this.append(
      this.responseBody,
      this.decoder.decode(chunk, { stream: true }),
    );
  }
  private append(previous: string, next: string) {
    if (previous.length + next.length > limit) this.log.truncated = true;
    return (previous + next).slice(0, limit);
  }
  text(text: string) {
    this.output = this.append(this.output, text);
  }
  markTruncated() {
    this.log.truncated = true;
  }
  finish(error?: unknown): ModelDiagnosticLog {
    this.responseBody = this.append(this.responseBody, this.decoder.decode());
    if (this.log.response) this.log.response.body = this.redact(this.responseBody);
    this.log.output = this.redact(this.output);
    if (error) {
      const describe = (value: unknown) =>
        value instanceof Error ? `${value.name}: ${value.message}` : String(value);
      this.log.error = this.bounded(
        describe(error) +
          (error instanceof Error && error.cause ? `\n${describe(error.cause)}` : ''),
      );
    }
    return this.log;
  }
}

/** Capture the bytes consumed by the actual adapter, without a tee or a second request. */
export async function providerFetch(
  connection: ProviderConnection,
  url: string | URL,
  init: RequestInit,
) {
  const diagnostic = connection.diagnostics;
  diagnostic?.request(url, init);
  const response = await fetch(url, init);
  if (!diagnostic) return response;
  diagnostic.response(response);
  if (!response.body) return response;
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            reader.releaseLock();
          } else {
            diagnostic.chunk(value);
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
          reader.releaseLock();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}

/** Ordinary calls discard upstream errors; explicit probes retain a bounded, redacted body. */
export async function captureErrorBody(response: Response, connection: ProviderConnection) {
  if (!response.body) return;
  if (!connection.diagnostics) {
    await response.body.cancel();
    return;
  }
  const reader = response.body.getReader();
  try {
    let size = 0;
    while (size <= limit) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
    }
    if (size > limit) connection.diagnostics.markTruncated();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
