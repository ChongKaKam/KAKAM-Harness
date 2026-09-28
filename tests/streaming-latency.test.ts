import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import type { ModelAdapter } from '../src/adapters/registry';
import { testModelConnection } from '../src/features/models/connection-test';

for (const apiMode of ['responses', 'chat-completions'] as const) {
  test(
    `${apiMode} forwards a fragmented Unicode delta before the upstream finishes`,
    { timeout: 3000 },
    async (t) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let closed = false;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        assert.equal(body.stream, true);
        assert.equal(
          apiMode === 'responses' ? body.reasoning.effort : body.reasoning_effort,
          'low',
        );
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      });
      const frame = encoder.encode(
        `data: ${JSON.stringify(
          apiMode === 'responses'
            ? { type: 'response.output_text.delta', delta: '你好' }
            : { choices: [{ delta: { content: '你好' } }] },
        )}\r\n\r\n`,
      );
      // Every byte arrives separately: JSON, UTF-8 and SSE frame boundaries may all be split.
      for (const byte of frame) controller.enqueue(Uint8Array.of(byte));
      const iterator = new OpenAICompatibleAdapter()
        .generate(
          { baseUrl: 'https://fixture.invalid/v1', apiKey: '', apiMode },
          'fixture',
          [{ role: 'user', content: 'hi' }],
          AbortSignal.timeout(2000),
          'low',
        )
        [Symbol.asyncIterator]();
      const first = await iterator.next();
      assert.deepEqual(first, { done: false, value: { type: 'text', text: '你好' } });
      assert.equal(closed, false);
      // The final event is deliberately withheld until the consumer has received the text.
      controller.enqueue(
        encoder.encode(
          apiMode === 'responses'
            ? 'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n'
            : 'data: {"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n',
        ),
      );
      closed = true;
      controller.close();
      assert.deepEqual((await iterator.next()).value, {
        type: 'usage',
        usage: { input: 2, output: 1, total: 3 },
      });
      assert.equal((await iterator.next()).done, true);
    },
  );
}

test('connection probes keep first-text timing distinct from completion, and preserve latest cumulative usage on failure', async () => {
  const controller = new AbortController();
  const adapter: ModelAdapter = {
    async discover() {
      return [];
    },
    async *generate() {
      yield { type: 'usage', usage: { input: 2, output: 0, total: 2 } };
      yield { type: 'text', text: 'OK' };
      yield { type: 'usage', usage: { input: 2, output: 3, total: 5 } };
      controller.abort();
      throw new Error('secret upstream diagnostic');
    },
  };
  const result = await testModelConnection(
    adapter,
    { baseUrl: '', apiKey: '' },
    'fixture',
    'none',
    controller.signal,
  );
  assert.equal(result.ok, false);
  assert.notEqual(result.firstTextMs, null);
  assert.ok(result.latencyMs >= result.firstTextMs!);
  assert.deepEqual(result.usage, { input: 2, output: 3, total: 5 });
  assert.match(result.error!, /超时/);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('a successful HTTP stream without visible text is not a successful model connection', async () => {
  const adapter: ModelAdapter = {
    async discover() {
      return [];
    },
    async *generate() {
      yield { type: 'usage', usage: { input: 2, output: 0, total: 2 } };
    },
  };
  const result = await testModelConnection(adapter, { baseUrl: '', apiKey: '' }, 'fixture', 'none');
  assert.equal(result.ok, false);
  assert.equal(result.firstTextMs, null);
  assert.equal(result.textChunks, 0);
  assert.deepEqual(result.usage, { input: 2, output: 0, total: 2 });
});
