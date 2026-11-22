import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import { AnthropicMessagesAdapter } from '../src/adapters/anthropic-messages';
import { unsupportedMaxEffortMessage } from '../src/adapters/reasoning-error';
import type { ApiMode } from '../src/shared/types';
import type { ToolEvent } from '../src/adapters/registry';

const modes = ['responses', 'anthropic-messages'] as const;
const messages = [{ role: 'user' as const, content: 'hello' }];
const maxMessage = '当前模型不支持 Max 思考强度，请切换其他思考程度后重试。';

test('only explicit Max effort rejections produce the safe actionable message', () => {
  for (const error of [
    { error: { message: "output_config.effort: Input should be 'low', 'medium' or 'high'" } },
    {
      error: { param: 'reasoning_effort', code: 'unsupported_value', message: 'Unsupported value' },
    },
    { error: { message: 'output_config.effort: max is not supported by this model' } },
    { response: { error: { message: "Invalid value: 'max' for reasoning.effort" } } },
    'Max reasoning effort is not supported',
  ]) {
    assert.equal(unsupportedMaxEffortMessage(error, 'max'), maxMessage);
    assert.equal(unsupportedMaxEffortMessage(error, 'high'), undefined);
  }
  for (const error of [
    { error: { message: 'Quota exceeded at max reasoning effort' } },
    { error: { param: 'max_tokens', message: 'Invalid value for max_tokens' } },
    { error: { param: 'temperature', message: 'temperature is unsupported with max effort' } },
    { error: { message: 'Authentication failed' } },
    { error: { message: 'Invalid request', request: { reasoning_effort: 'max' } } },
  ])
    assert.equal(unsupportedMaxEffortMessage(error, 'max'), undefined);
});

test('Max passes through all protocols and safe rejection preserves usage without retrying', async (t) => {
  const requests: { mode: ApiMode; body: Record<string, any> }[] = [];
  const server = createServer(async (req, res) => {
    if (!['/responses', '/messages'].includes(req.url!)) {
      res.writeHead(404).end();
      return;
    }
    const mode = req.url === '/responses' ? 'responses' : 'anthropic-messages';
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push({ mode, body });
    const effort = mode === 'responses' ? body.reasoning?.effort : body.output_config?.effort;
    const error = {
      type: 'invalid_request_error',
      param: mode === 'responses' ? 'reasoning.effort' : 'output_config.effort',
      code: 'unsupported_value',
      message: 'Max effort is not supported. sensitive fixture credential',
    };
    if (body.model === 'unsupported' && effort === 'max') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
      return;
    }
    if (body.model === 'unrelated' || body.model === 'overloaded') {
      res.writeHead(body.model === 'overloaded' ? 503 : 400, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          error: body.model === 'overloaded' ? error : { ...error, param: 'temperature' },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const frame = (packet: unknown) => res.write(`data: ${JSON.stringify(packet)}\n\n`);
    if (body.model === 'stream-unsupported') {
      if (mode === 'anthropic-messages') {
        frame({ type: 'message_start', message: { usage: { input_tokens: 3 } } });
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        });
        frame({ type: 'error', error });
      } else {
        frame({
          type: 'response.failed',
          response: { error, usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
        });
      }
    } else if (mode === 'anthropic-messages') {
      frame({ type: 'message_start', message: { usage: { input_tokens: 3 } } });
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } });
      frame({
        type: 'message_delta',
        delta: { stop_reason: body.model === 'truncated' ? 'max_tokens' : 'end_turn' },
        usage: { output_tokens: 2 },
      });
      frame({ type: 'message_stop' });
    } else {
      frame({ type: 'response.output_text.delta', delta: 'done' });
      frame({
        type: body.model === 'truncated' ? 'response.incomplete' : 'response.completed',
        response: { output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } },
      });
    }
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    for (const apiMode of modes) {
      const adapter =
        apiMode === 'anthropic-messages'
          ? new AnthropicMessagesAdapter()
          : new OpenAICompatibleAdapter();
      const connection = {
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: '',
        apiMode,
        maxOutputTokens: 12345,
      };
      for (const tools of [false, true]) {
        await t.test(`${apiMode} ${tools ? 'tool' : 'plain'} generation`, async () => {
          const generate = (model: string, effort: 'max' | 'high') =>
            tools
              ? adapter.generateTurn(
                  connection,
                  model,
                  messages,
                  [],
                  [],
                  AbortSignal.timeout(3000),
                  effort,
                )
              : adapter.generate(connection, model, messages, AbortSignal.timeout(3000), effort);
          const events: ToolEvent[] = [];
          const drain = async (model: string, effort: 'max' | 'high') => {
            for await (const event of generate(model, effort)) events.push(event);
          };
          await drain('supported', 'max');
          const body = requests.at(-1)!.body;
          const outputField = {
            responses: 'max_output_tokens',
            'anthropic-messages': 'max_tokens',
          }[apiMode];
          assert.deepEqual(
            Object.keys(body).filter((key) => key.startsWith('max_')),
            [outputField],
          );
          assert.equal(body[outputField], 12345);
          assert.equal(
            apiMode === 'responses' ? body.reasoning.effort : body.output_config.effort,
            'max',
          );
          for (const model of ['unsupported', 'stream-unsupported']) {
            const before = requests.length;
            events.length = 0;
            await assert.rejects(drain(model, 'max'), { message: maxMessage });
            assert.equal(requests.length, before + 1);
            if (model === 'stream-unsupported')
              assert.ok(events.some((e) => e.type === 'usage' && e.usage.total === 5));
          }
          events.length = 0;
          await assert.rejects(drain('truncated', 'high'), /未完成|生成中断|正常完成|输出上限/);
          assert.ok(events.some((event) => event.type === 'text' && event.text === 'done'));
          assert.deepEqual(events.at(-1), {
            type: 'usage',
            usage: { input: 3, output: 2, total: 5 },
          });
          await drain('unsupported', 'high');
          for (const model of ['unrelated', 'overloaded'])
            await assert.rejects(
              drain(model, 'max'),
              (error) =>
                error instanceof Error &&
                error.message !== maxMessage &&
                !error.message.includes('sensitive fixture credential'),
            );
        });
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
