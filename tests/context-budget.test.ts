import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicMessagesAdapter } from '../src/adapters/anthropic-messages';
import { checkContextBudget } from '../src/adapters/context-budget';
import { generationRequest } from '../src/adapters/generation-request';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import type {
  ModelAdapter,
  ProviderMessage,
  ToolDefinition,
  ToolStep,
} from '../src/adapters/registry';

const connection = {
  apiKey: '',
  baseUrl: 'https://mock.invalid',
  contextWindowTokens: 4_500,
  maxOutputTokens: 512,
};
const text = 'A'.repeat(48_000);
const userText: ProviderMessage[] = [{ role: 'user', content: 'Look at this.' }];
const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const tool = { name: 'read_note', description: 'Read the note', parameters: schema };
const signal = new AbortController().signal;
const overBudget = { status: 413 };

async function drain(events: AsyncIterable<unknown>) {
  for await (const _event of events) {
    /* Consume the complete stream. */
  }
}

for (const apiMode of ['responses', 'anthropic-messages'] as const) {
  test(`${apiMode} applies its model budget before every text and tool request`, async (t) => {
    const adapter: ModelAdapter =
      apiMode === 'anthropic-messages'
        ? new AnthropicMessagesAdapter()
        : new OpenAICompatibleAdapter();
    const modelConnection = { ...connection, apiMode };
    const frames = {
      responses: [{ type: 'response.completed', response: { output: [] } }],
      'anthropic-messages': [
        { type: 'message_start', message: {} },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ],
    }[apiMode];
    const fetch = t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    );
    const plain = (messages: ProviderMessage[]) =>
      drain(adapter.generate(modelConnection, 'model', messages, signal));
    const withTools = (
      messages: ProviderMessage[],
      tools: ToolDefinition[] = [tool],
      steps: ToolStep[] = [],
    ) => drain(adapter.generateTurn!(modelConnection, 'model', messages, tools, steps, signal));
    const image: ProviderMessage[] = [
      {
        role: 'user',
        content: 'Look',
        images: [{ name: 'file.png', data: 'data:image/png;base64,' + text }],
      },
    ];
    await plain(image);
    await withTools(image);
    assert.equal(fetch.mock.callCount(), 2);

    // Identical bytes in user text still occupy context. No overflowing case may contact the provider.
    const largeMessage: ProviderMessage[] = [{ role: 'user', content: text }];
    await assert.rejects(plain(largeMessage), overBudget);
    await assert.rejects(withTools(largeMessage), overBudget);
    await assert.rejects(
      withTools(userText, [{ ...tool, parameters: { ...schema, description: text } }]),
      overBudget,
    );

    const nativeReasoning = {
      responses: { type: 'reasoning', encrypted_content: text },
      'anthropic-messages': {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Plan', signature: text }],
      },
    }[apiMode];
    const emptyStep: ToolStep = { turn: { calls: [], continuation: [] }, results: [] };
    for (const step of [
      { ...emptyStep, turn: { calls: [], continuation: [nativeReasoning] } },
      { ...emptyStep, results: [{ id: 'call-1', output: text }] },
      { ...emptyStep, steering: [text] },
    ])
      await assert.rejects(withTools(userText, [tool], [step]), overBudget);
    assert.equal(fetch.mock.callCount(), 2);
  });
}

test('native system instructions are included in the input budget', () => {
  assert.throws(
    () =>
      checkContextBudget(connection, {
        system: [{ type: 'text', text }],
        messages: [],
        max_tokens: 512,
      }),
    overBudget,
  );
});

test('Anthropic keeps room for input when a small gateway omits the optional output setting', () => {
  const body = generationRequest(
    'anthropic-messages',
    { ...connection, contextWindowTokens: 8192, maxOutputTokens: null },
    'model',
    userText,
    'high',
  );
  assert.equal(body.max_tokens, 4096);
});

test('a 1M window admits large inputs while still reserving the configured output', () => {
  const gateway = { ...connection, contextWindowTokens: 1_000_000, maxOutputTokens: 16_000 };
  const request = (size: number) =>
    generationRequest(
      'responses',
      gateway,
      'model',
      [{ role: 'user', content: 'a'.repeat(size) }],
      'none',
    );
  assert.equal(request(2_900_000).max_output_tokens, 16_000);
  assert.throws(() => request(2_970_000), overBudget);
});
