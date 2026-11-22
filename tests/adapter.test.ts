import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import type { ReasoningEffort } from '../src/shared/types';
import { mockProvider, imageData } from './mock-provider';
let mock: Awaited<ReturnType<typeof mockProvider>>;
const adapter = new OpenAICompatibleAdapter();
before(async () => {
  mock = await mockProvider();
});
after(async () => {
  await mock.close();
});
for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as ReasoningEffort[]) {
  test(`Responses correctly maps images, streaming, usage and ${effort} effort`, async () => {
    const events = [];
    for await (const e of adapter.generate(
      { baseUrl: mock.url, apiKey: 'fixture' },
      'test-vision',
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'image', images: [{ name: 'test.png', data: imageData }] },
      ],
      AbortSignal.timeout(3000),
      effort,
    ))
      events.push(e);
    assert.ok(events.some((e) => e.type === 'text' && e.text.includes('你好')));
    assert.deepEqual(events.at(-1), {
      type: 'usage',
      usage: { input: 23, output: 42, total: 65 },
    });
    const body = mock.requests.at(-1) as Record<string, any>;
    assert.ok(!Object.keys(body).some((key) => key.startsWith('max_')));
    assert.equal(body.store, false);
    assert.deepEqual(body.input[2].content[1], {
      type: 'input_image',
      image_url: imageData,
      detail: 'auto',
    });
    assert.equal(body.reasoning?.effort, effort === 'none' ? undefined : effort);
    assert.ok(!('reasoning_effort' in body));
    if (effort === 'none') assert.ok(!('reasoning' in body));
  });
}
for (const model of ['broken', 'incomplete', 'failed', 'upstream-error'])
  test(`Responses ${model} propagates failure without leaking provider details`, async () => {
    await assert.rejects(
      async () => {
        for await (const _event of adapter.generate(
          { baseUrl: mock.url, apiKey: 'fixture', apiMode: 'responses' },
          model,
          [{ role: 'user', content: 'hi' }],
          AbortSignal.timeout(3000),
        )) {
          /* drain */
        }
      },
      (error) => error instanceof Error && !error.message.includes('sensitive upstream details'),
    );
  });

test('the wrong provider mode cannot initiate plain or tool generation', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected network request');
  });
  for (const apiMode of ['jev', 'anthropic-messages'] as const) {
    const connection = { baseUrl: mock.url, apiKey: '', apiMode };
    for (const stream of [
      adapter.generate(connection, 'unconfigured', [], AbortSignal.timeout(3000)),
      adapter.generateTurn(connection, 'unconfigured', [], [], [], AbortSignal.timeout(3000)),
    ])
      await assert.rejects(stream[Symbol.asyncIterator]().next(), { status: 400 });
  }
  assert.equal(fetch.mock.callCount(), 0);
});
