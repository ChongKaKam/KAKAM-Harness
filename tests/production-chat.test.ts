import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app';
import { mockProvider, imageData } from './mock-provider';
import { productionFileName, productionFileContent } from './production-provider-fixture';
import type { ApiMode, StreamEvent, Message } from '../src/shared/types';

let application: Awaited<ReturnType<typeof createApp>>;
let provider: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let directory: string, url: string, cookie: string;
const models = new Map<ApiMode, string>();
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
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-production-chat-'));
  provider = await mockProvider();
  application = await createApp({
    dataDir: directory,
    secret: 'production-chat-test-secret-at-least-32',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  server = createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const registration = await request('/auth/register', 'POST', {
    email: 'production-chat@example.test',
    displayName: '产物测试',
    password: 'x',
  });
  assert.equal(registration.status, 201);
  cookie = registration.headers.get('set-cookie')!.split(';')[0];
  for (const apiMode of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
    const source = await json('/admin/providers', 'POST', {
      name: apiMode,
      baseUrl: provider.url,
      apiKey: 'test',
      apiMode,
    });
    const model = await json('/admin/models', 'POST', {
      providerId: source.id,
      name: 'production-tool',
      label: apiMode,
      toolCalling: true,
    });
    models.set(apiMode, model.id);
  }
});
after(async () => {
  await application?.kernel.stop();
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  await provider?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const apiMode of ['chat-completions', 'responses', 'anthropic-messages'] as const) {
  test(`${apiMode}: actual file tool output is persisted, downloadable, replayable and request-idempotent`, async () => {
    const conversation = await json('/conversations', 'POST');
    const requestId = randomUUID();
    const body = {
      requestId,
      modelId: models.get(apiMode),
      content: '生成一个 Markdown 文件 [production-slow]',
    };
    await json(`/conversations/${conversation.id}/messages`, 'POST', body);
    const events = (await (await request(`/conversations/${conversation.id}/events`)).text())
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as StreamEvent);
    const done = events.find((event) => event.type === 'done');
    const persisted = (await json(`/conversations/${conversation.id}`)).messages as Message[];
    const answer = persisted.find((message) => message.id === requestId)!;
    assert.equal(answer.status, 'complete', answer.error ?? 'generation must complete');
    assert.equal(answer.artifacts?.length, 1);
    assert.equal(answer.artifacts![0].name, productionFileName);
    assert.deepEqual(answer.usage, { input: 46, output: 84, total: 130 });
    assert.ok(events.some((event) => event.type === 'artifacts' && event.artifacts.length === 1));
    if (done?.type === 'done') assert.deepEqual(done.message.artifacts, answer.artifacts);
    const download = await request(`/llm-production/artifacts/${answer.artifacts![0].id}/download`);
    assert.equal(download.status, 200);
    assert.equal(await download.text(), productionFileContent);
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    const reconnect = await (await request(`/conversations/${conversation.id}/events`)).text();
    const snapshot = JSON.parse(reconnect.split('\n\n')[0].slice(6));
    assert.deepEqual(
      snapshot.messages.find((message: Message) => message.id === requestId).artifacts,
      answer.artifacts,
    );
    const requestsBefore = provider.requests.length;
    await json(`/conversations/${conversation.id}/messages`, 'POST', body);
    assert.equal(provider.requests.length, requestsBefore);
    assert.equal(
      (await json(`/llm-production/artifacts?conversationId=${conversation.id}`)).artifacts.length,
      1,
    );
  });
}

test('viewer disconnection preserves file generation and final snapshot; disabling generation keeps ordinary chat usable', async () => {
  const conversation = await json('/conversations', 'POST');
  const requestId = randomUUID();
  await json(`/conversations/${conversation.id}/messages`, 'POST', {
    requestId,
    modelId: models.get('chat-completions'),
    content: '生成文件 [production-slow]',
  });
  const controller = new AbortController();
  const subscription = await fetch(`${url}/api/conversations/${conversation.id}/events`, {
    headers: { cookie },
    signal: controller.signal,
  });
  await subscription.body!.getReader().read();
  controller.abort();
  let answer: Message | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    answer = (await json(`/conversations/${conversation.id}`)).messages.find(
      (message: Message) => message.id === requestId,
    );
    if (answer?.status !== 'streaming') break;
    await delay(20);
  }
  assert.equal(answer?.status, 'complete');
  assert.equal(answer?.artifacts?.length, 1);
  await json('/llm-production/preferences', 'PATCH', { enabled: false });
  const ordinary = await json('/conversations', 'POST');
  const noFilesId = randomUUID();
  await json(`/conversations/${ordinary.id}/messages`, 'POST', {
    requestId: noFilesId,
    modelId: models.get('chat-completions'),
    content: '普通聊天',
  });
  await (await request(`/conversations/${ordinary.id}/events`)).text();
  const noFiles = (await json(`/conversations/${ordinary.id}`)).messages.find(
    (message: Message) => message.id === noFilesId,
  );
  assert.equal(noFiles.status, 'complete');
  assert.deepEqual(noFiles.artifacts, []);
  await json('/llm-production/preferences', 'PATCH', { enabled: true });
});

test('image tool uses the selected authorized model and persists real image bytes with separate usage', async () => {
  const source = await json('/admin/providers', 'POST', {
    name: 'Image source',
    baseUrl: provider.url,
    apiKey: 'test',
  });
  const imageModel = await json('/admin/models', 'POST', {
    providerId: source.id,
    name: 'production-image',
    label: 'Image model',
    kind: 'image',
  });
  await json('/llm-production/preferences', 'PATCH', {
    enabled: true,
    imageModelId: imageModel.id,
  });
  const conversation = await json('/conversations', 'POST');
  const messageId = randomUUID();
  await json(`/conversations/${conversation.id}/messages`, 'POST', {
    requestId: messageId,
    modelId: models.get('chat-completions'),
    content: '生成图片 [production-image] [production-slow]',
  });
  await (await request(`/conversations/${conversation.id}/events`)).text();
  const answer = (await json(`/conversations/${conversation.id}`)).messages.find(
    (message: Message) => message.id === messageId,
  );
  assert.equal(answer.status, 'complete', answer.error);
  assert.equal(answer.artifacts.length, 1);
  assert.equal(answer.artifacts[0].mimeType, 'image/png');
  const download = await request(`/llm-production/artifacts/${answer.artifacts[0].id}/download`);
  assert.deepEqual(
    Buffer.from(await download.arrayBuffer()),
    Buffer.from(imageData.split(',')[1], 'base64'),
  );
  assert.deepEqual(answer.usage, { input: 46, output: 84, total: 130 });
  const usage = application.kernel.ctx.db.get<{
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }>(
    "SELECT * FROM usage WHERE model_name='[图片生成] production-image' ORDER BY rowid DESC LIMIT 1",
  )!;
  assert.deepEqual([usage.input_tokens, usage.output_tokens, usage.total_tokens], [12, 17, 29]);
  const before = provider.requests.length;
  await json(`/admin/models/${imageModel.id}`, 'PATCH', {
    enabled: false,
    vision: false,
    label: 'Image model',
    userIds: [],
  });
  const production = application.kernel.ctx.extensions.conversationTools(
    (await json('/auth/me')).user,
  );
  assert.ok(!production.tools.some((tool) => tool.name === 'production_generate_image'));
  assert.equal(provider.requests.length, before);
  await json('/llm-production/preferences', 'PATCH', { imageModelId: null });
});
