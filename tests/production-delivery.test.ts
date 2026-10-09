import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app';
import { mockProvider, imageData } from './mock-provider';
import type { ApiMode, Message, StreamEvent } from '../src/shared/types';

let app: Awaited<ReturnType<typeof createApp>>;
let provider: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let directory: string,
  url: string,
  cookie: string,
  imageId: string,
  failureImageId: string,
  basicId: string;
const models = new Map<string, string>();
async function request(path: string, method = 'GET', body?: unknown) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}
async function json(path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await request(path, method, body);
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function send(
  modelName: string,
  mode: ApiMode = 'chat-completions',
  productionMode = 'required',
  content = '继续完成刚才的任务',
) {
  const conversation = await json('/conversations', 'POST');
  const requestId = randomUUID();
  const payload = {
    requestId,
    modelId: models.get(`${mode}:${modelName}`),
    content,
    productionMode,
  };
  assert.equal(
    (await request(`/conversations/${conversation.id}/messages`, 'POST', payload)).status,
    202,
  );
  const events = (await (await request(`/conversations/${conversation.id}/events`)).text())
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as StreamEvent);
  const messages = (await json(`/conversations/${conversation.id}`)).messages as Message[];
  const answer = messages.find((message) => message.id === requestId)!;
  return { conversation, payload, events, answer, messages };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-production-delivery-'));
  provider = await mockProvider();
  app = await createApp({
    dataDir: directory,
    secret: 'production-delivery-secret-at-least-32',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const registration = await request('/auth/register', 'POST', {
    email: 'delivery@example.test',
    displayName: '交付测试',
    password: 'x',
  });
  assert.equal(registration.status, 201);
  cookie = registration.headers.get('set-cookie')!.split(';')[0];
  for (const apiMode of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
    const source = await json('/admin/providers', 'POST', {
      name: apiMode,
      baseUrl: provider.url,
      apiKey: 'fixture',
      apiMode,
    });
    const names =
      apiMode === 'chat-completions'
        ? [
            'delivery-mixed',
            'delivery-noplan',
            'delivery-partial',
            'delivery-clarify',
            'delivery-auto',
            'delivery-shrink',
            'delivery-wrong-format',
            'delivery-direct-image-failure',
            'delivery-sequential',
          ]
        : ['delivery-mixed'];
    for (const name of names)
      models.set(
        `${apiMode}:${name}`,
        (
          await json('/admin/models', 'POST', {
            providerId: source.id,
            name,
            label: `${apiMode}:${name}`,
            toolCalling: true,
          })
        ).id,
      );
    if (apiMode === 'chat-completions') {
      imageId = (
        await json('/admin/models', 'POST', {
          providerId: source.id,
          name: 'production-image',
          label: '交付图片',
          kind: 'image',
        })
      ).id;
      failureImageId = (
        await json('/admin/models', 'POST', {
          providerId: source.id,
          name: 'production-image-failure',
          label: '失败图片',
          kind: 'image',
        })
      ).id;
      basicId = (
        await json('/admin/models', 'POST', {
          providerId: source.id,
          name: 'basic',
          label: '无工具模型',
          toolCalling: false,
        })
      ).id;
    }
  }
});
beforeEach(async () => {
  await json('/llm-production/preferences', 'PATCH', { enabled: true, imageModelId: imageId });
});
after(async () => {
  await app?.kernel.stop();
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  await provider?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const mode of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
  test(`${mode}: required mixed plan delivers four distinct files and reuses completed image without paid repeat`, async () => {
    const start = provider.requests.length;
    const { answer, messages, events, conversation, payload } = await send('delivery-mixed', mode);
    assert.equal(answer.status, 'complete', answer.error ?? 'must complete');
    assert.equal(messages[0].productionMode, 'required');
    assert.equal(answer.productionMode, 'required');
    assert.equal(answer.productionDelivery?.items.length, 4);
    assert.ok(answer.productionDelivery?.items.every((item) => item.status === 'complete'));
    assert.equal(new Set(answer.productionDelivery?.items.map((item) => item.artifactId)).size, 4);
    assert.equal(answer.artifacts?.length, 4);
    const calls = provider.requests.slice(start) as Array<{
      model: string;
      tools?: any[];
      tool_choice?: unknown;
    }>;
    assert.equal(calls.filter((call) => call.model === 'delivery-mixed').length, 3);
    assert.equal(calls.filter((call) => call.model === 'production-image').length, 2);
    assert.deepEqual(
      calls[0].tools?.map((tool) => tool.name ?? tool.function?.name),
      ['production_plan'],
    );
    assert.equal(calls[0].tool_choice, mode === 'anthropic-messages' ? undefined : 'required');
    assert.equal(
      calls.filter((call) => call.model === 'delivery-mixed').at(-1)?.tool_choice,
      undefined,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === 'artifacts' &&
          event.productionDelivery?.items.every((item) => item.status === 'pending'),
      ),
    );
    for (const artifact of answer.artifacts!) {
      assert.ok(artifact.deliveryItemId);
      const response = await request(`/llm-production/artifacts/${artifact.id}/download`);
      assert.equal(response.status, 200);
      if (artifact.mimeType === 'image/png')
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          Buffer.from(imageData.split(',')[1], 'base64'),
        );
    }
    const count = provider.requests.length;
    assert.equal(
      (await request(`/conversations/${conversation.id}/messages`, 'POST', payload)).status,
      202,
    );
    assert.equal(provider.requests.length, count);
  });
}
test('required mode rejects code-only success and keeps provider usage and partial text', async () => {
  const { answer } = await send('delivery-noplan');
  assert.equal(answer.status, 'error');
  assert.match(answer.error ?? '', /交付计划/);
  assert.match(answer.content, /```html/);
  assert.deepEqual(answer.artifacts, []);
  assert.equal(answer.productionDelivery, null);
  assert.deepEqual(answer.usage, { input: 23, output: 42, total: 65 });
});
test('required mode retains explicit user-format validation even when the declared plan is fully delivered', async () => {
  const { answer } = await send(
    'delivery-mixed',
    'chat-completions',
    'required',
    '生成一个 PDF 文件',
  );
  assert.equal(answer.status, 'error');
  assert.match(answer.error ?? '', /PDF/);
  assert.ok(answer.productionDelivery?.items.every((item) => item.status === 'complete'));
  assert.equal(answer.artifacts?.length, 4);
  assert.ok(answer.artifacts?.every((artifact) => artifact.mimeType !== 'application/pdf'));
});
test('missing items fail the reply while completed files and locked plan remain available', async () => {
  for (const model of ['delivery-partial', 'delivery-shrink', 'delivery-wrong-format']) {
    const { answer } = await send(model);
    assert.equal(answer.status, 'error');
    assert.equal(answer.productionDelivery?.items.length, 4);
    assert.equal(answer.artifacts?.length, model === 'delivery-partial' ? 1 : 0);
    assert.match(answer.error ?? '', /未完成产物交付/);
  }
});
test('clarification is a valid completed outcome with a persisted question and no files', async () => {
  const { answer } = await send('delivery-clarify');
  assert.equal(answer.status, 'complete');
  assert.equal(answer.productionDelivery?.decision, 'clarify');
  assert.match(answer.productionDelivery?.question ?? '', /哪些文件/);
  assert.deepEqual(answer.artifacts, []);
});
test('ordinary Auto messages use one main-model request without an auxiliary planning call', async () => {
  const start = provider.requests.length;
  const { answer } = await send('delivery-auto', 'chat-completions', 'auto');
  assert.equal(answer.status, 'complete');
  assert.equal(answer.productionDelivery, null);
  assert.equal(provider.requests.length - start, 1);
});
test('an Auto plan can deliver twelve files sequentially within the shared tool budget', async () => {
  const start = provider.requests.length;
  const { answer } = await send('delivery-sequential', 'chat-completions', 'auto');
  assert.equal(answer.status, 'complete', answer.error ?? 'must finish all twelve');
  assert.equal(answer.productionDelivery?.items.length, 12);
  assert.ok(answer.productionDelivery?.items.every((item) => item.status === 'complete'));
  assert.equal(answer.artifacts?.length, 12);
  assert.equal(provider.requests.length - start, 14);
});
test('planned and unplanned image failures preserve files and never automatically retry paid generation', async () => {
  await json('/llm-production/preferences', 'PATCH', { imageModelId: failureImageId });
  for (const model of ['delivery-mixed', 'delivery-direct-image-failure']) {
    const start = provider.requests.length;
    const { answer } = await send(
      model,
      'chat-completions',
      model === 'delivery-mixed' ? 'required' : 'auto',
    );
    assert.equal(answer.status, 'error');
    assert.match(answer.error ?? '', /HTTP 502/);
    assert.equal(
      (provider.requests.slice(start) as Array<{ model: string }>).filter(
        (call) => call.model === 'production-image-failure',
      ).length,
      1,
    );
    assert.equal(answer.artifacts?.length, model === 'delivery-mixed' ? 2 : 0);
    if (model === 'delivery-mixed')
      assert.equal(answer.productionDelivery?.items[2].status, 'failed');
  }
});
test('required mode preflights tool capability and generation settings before starting a model request', async () => {
  const conversation = await json('/conversations', 'POST');
  for (const disabled of [false, true]) {
    await json('/llm-production/preferences', 'PATCH', { enabled: !disabled });
    const start = provider.requests.length;
    const response = await request(`/conversations/${conversation.id}/messages`, 'POST', {
      modelId: basicId,
      content: '继续',
      productionMode: 'required',
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, disabled ? /启用生成/ : /工具调用/);
    assert.equal(provider.requests.length, start);
  }
});
