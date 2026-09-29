import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mockProvider } from './mock-provider';
import { JevAdapter } from '../src/adapters/jev';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import { AnthropicMessagesAdapter } from '../src/adapters/anthropic-messages';
import { testModelConnection } from '../src/features/models/connection-test';
import { createServer } from 'node:http';
let mock: Awaited<ReturnType<typeof mockProvider>>;
before(async () => {
  mock = await mockProvider();
});
after(async () => {
  await mock.close();
});

test('Jev diagnosis exposes English native input and HTTP 401 output without exposing credentials', async () => {
  const result = await testModelConnection(
    new JevAdapter(),
    {
      baseUrl: mock.url.replace('/v1', '/jev'),
      apiKey: 'test-jev-key',
      apiMode: 'jev',
    },
    'jev-error',
    'none',
  );
  assert.equal(result.ok, false);
  assert.equal(result.usage, null);
  assert.match(result.error!, /401.*鉴权/);
  assert.equal(result.diagnostics.request?.method, 'POST');
  assert.match(result.diagnostics.request!.url, /\/jev\/systemone$/);
  const input = JSON.parse(result.diagnostics.request!.body);
  assert.equal(input.state, 'The user asks for current news.');
  assert.equal(input.questions.enabled.type, 'choice');
  assert.equal(result.diagnostics.response?.status, 401);
  assert.match(result.diagnostics.response!.body, /Invalid API key/);
  assert.match(result.diagnostics.request!.headers.authorization, /REDACTED/);
  assert.ok(!JSON.stringify(result).includes('test-jev-key'));
});

for (const apiMode of ['chat-completions', 'responses', 'anthropic-messages', 'jev'] as const) {
  test(`${apiMode} diagnostic captures actual request and output while preserving provider usage`, async () => {
    const adapter =
      apiMode === 'jev'
        ? new JevAdapter()
        : apiMode === 'anthropic-messages'
          ? new AnthropicMessagesAdapter()
          : new OpenAICompatibleAdapter();
    const result = await testModelConnection(
      adapter,
      {
        baseUrl: apiMode === 'jev' ? mock.url.replace('/v1', '/jev') : mock.url,
        apiKey: 'fixture-key',
        apiMode,
      },
      apiMode === 'jev' ? 'jev-latest' : 'test-text',
      'none',
    );
    assert.equal(result.ok, true);
    assert.ok(result.usage);
    assert.equal(result.diagnostics.response?.status, 200);
    assert.ok(result.diagnostics.output.length);
    assert.ok(result.diagnostics.response!.body.length);
    assert.ok(!JSON.stringify(result.diagnostics).includes('fixture-key'));
  });
}

test('partial streaming failure retains output, HTTP response and usage in diagnostics', async () => {
  const result = await testModelConnection(
    new OpenAICompatibleAdapter(),
    {
      baseUrl: mock.url,
      apiKey: 'fixture',
      apiMode: 'responses',
    },
    'failed',
    'none',
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.response?.status, 200);
  assert.ok(result.diagnostics.output.length);
  assert.match(result.diagnostics.response!.body, /response.failed/);
  assert.equal(result.usage?.total, 65);
});

test('diagnostic bounds redact echoed credentials even when truncation cuts through a key', async () => {
  const key = 'credential-that-must-never-appear';
  const server = createServer((_req, res) => {
    res.writeHead(401, {
      'Content-Type': 'text/plain',
      'Set-Cookie': 'private-cookie',
      'X-Request-Id': 'diagnostic-request',
    });
    res.write('x'.repeat(32_760));
    res.end(key + 'x'.repeat(40_000));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await testModelConnection(
      new JevAdapter(),
      {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        apiKey: key,
        apiMode: 'jev',
      },
      'jev-latest',
      'none',
    );
    assert.equal(result.diagnostics.truncated, true);
    const log = JSON.stringify(result.diagnostics);
    assert.ok(!log.includes('credenti'));
    assert.ok(!log.includes('private-cookie'));
    assert.match(log, /diagnostic-request/);
    assert.ok(log.length < 35_000);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }
});

test('timeout before response preserves the input and an explicit error without inventing HTTP status or usage', async () => {
  const result = await testModelConnection(
    new JevAdapter(),
    {
      baseUrl: mock.url.replace('/v1', '/jev'),
      apiKey: 'fixture',
      apiMode: 'jev',
    },
    'jev-slow',
    'none',
    AbortSignal.timeout(30),
  );
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.response, undefined);
  assert.ok(result.diagnostics.request);
  assert.match(result.diagnostics.error!, /Timeout|Abort/);
  assert.equal(result.usage, null);
});

test('malformed JSON preserves the upstream body and parser error', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{invalid-json');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await testModelConnection(
      new JevAdapter(),
      {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        apiKey: 'fixture',
        apiMode: 'jev',
      },
      'jev-latest',
      'none',
    );
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.response?.body, '{invalid-json');
    assert.match(result.diagnostics.error!, /SyntaxError/);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }
});
