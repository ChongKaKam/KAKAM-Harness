import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import type { ApiMode, ReasoningEffort } from '../src/shared/types';
import { mockProvider, imageData } from './mock-provider';
let mock: Awaited<ReturnType<typeof mockProvider>>;
const adapter = new OpenAICompatibleAdapter();
before(async () => {
  mock = await mockProvider();
});
after(async () => {
  await mock.close();
});
for (const apiMode of ['chat-completions', 'responses'] as ApiMode[]) {
  for (const effort of ['none', 'low', 'medium', 'high', 'xhigh'] as ReasoningEffort[]) {
    test(`${apiMode} correctly maps images, streaming, usage and ${effort} effort`, async () => {
      const events = [];
      for await (const e of adapter.generate(
        { baseUrl: mock.url, apiKey: 'fixture', apiMode },
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
      if (apiMode === 'responses') {
        assert.equal(body.store, false);
        assert.deepEqual(body.input[2].content[1], {
          type: 'input_image',
          image_url: imageData,
          detail: 'auto',
        });
        assert.equal(body.reasoning?.effort, effort === 'none' ? undefined : effort);
        assert.ok(!('reasoning_effort' in body));
      } else {
        assert.equal(body.messages[2].content[1].image_url.url, imageData);
        assert.equal(body.reasoning_effort, effort === 'none' ? undefined : effort);
        assert.ok(!('reasoning' in body));
      }
      if (effort === 'none') assert.ok(!('reasoning' in body) && !('reasoning_effort' in body));
    });
  }
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
