import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicMessagesAdapter } from '../src/adapters/anthropic-messages';
import type { ProviderEvent } from '../src/adapters/registry';
import { HttpError } from '../src/kernel/http';
import type { ReasoningEffort } from '../src/shared/types';
import { imageData, mockProvider } from './mock-provider';
let mock: Awaited<ReturnType<typeof mockProvider>>;
const adapter = new AnthropicMessagesAdapter();
before(async () => {
  mock = await mockProvider();
});
after(async () => {
  await mock.close();
});
const connection = () => ({ baseUrl: mock.url, apiKey: 'fixture-anthropic' });

test('Anthropic discovery follows pagination and uses native authentication', async () => {
  assert.deepEqual(await adapter.discover(connection()), ['test-vision', 'test-text']);
  for (const headers of mock.anthropicHeaders) {
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers['x-api-key'], 'fixture-anthropic');
    assert.equal(headers.authorization, undefined);
  }
});
for (const effort of ['none', 'low', 'medium', 'high', 'xhigh'] as ReasoningEffort[]) {
  test(`Anthropic ${effort}: text, images, history and cumulative cached token accounting`, async () => {
    const events: ProviderEvent[] = [];
    for await (const event of adapter.generate(
      connection(),
      'test-vision',
      [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: '', images: [{ name: 'pixel.png', data: imageData }] },
      ],
      AbortSignal.timeout(3000),
      effort,
    ))
      events.push(event);
    assert.ok(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join('')
        .includes('你好'),
    );
    assert.ok(!JSON.stringify(events).includes('not answer text'));
    assert.deepEqual(events.at(-1), { type: 'usage', usage: { input: 23, output: 42, total: 65 } });
    const body = mock.requests.at(-1) as Record<string, any>;
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages[1], {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    });
    assert.deepEqual(body.messages[2].content, [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: imageData.split(',')[1] },
      },
    ]);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.reasoning, undefined);
    if (effort === 'none') {
      assert.ok(!('thinking' in body));
      assert.ok(!('output_config' in body));
    } else {
      assert.deepEqual(body.thinking, { type: 'adaptive' });
      assert.deepEqual(body.output_config, { effort });
    }
    assert.equal(mock.anthropicHeaders.at(-1)?.['x-api-key'], 'fixture-anthropic');
  });
}
for (const model of ['no-usage', 'invalid-usage', 'zero-usage'])
  test(`Anthropic ${model} is not fabricated`, async () => {
    const events: ProviderEvent[] = [];
    for await (const event of adapter.generate(
      connection(),
      model,
      [{ role: 'user', content: 'hi' }],
      AbortSignal.timeout(3000),
    ))
      events.push(event);
    if (model === 'zero-usage')
      assert.deepEqual(events.at(-1), { type: 'usage', usage: { input: 0, output: 0, total: 0 } });
    else assert.equal(events.filter((e) => e.type === 'usage').length, 0);
  });
for (const model of ['broken', 'stream-error', 'incomplete', 'upstream-error'])
  test(`Anthropic ${model} is a sanitized failure`, async () => {
    await assert.rejects(
      async () => {
        for await (const _event of adapter.generate(
          connection(),
          model,
          [{ role: 'user', content: 'hi' }],
          AbortSignal.timeout(3000),
        )) {
          /* drain */
        }
      },
      (error) =>
        error instanceof HttpError && !error.message.includes('sensitive upstream details'),
    );
  });
test('Anthropic abort closes the reader and does not fabricate final usage', async () => {
  const controller = new AbortController();
  const events: ProviderEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of adapter.generate(
      connection(),
      'slow',
      [{ role: 'user', content: 'hi' }],
      controller.signal,
    )) {
      events.push(event);
      controller.abort();
    }
  });
  assert.equal(events.filter((e) => e.type === 'usage').length, 0);
});
