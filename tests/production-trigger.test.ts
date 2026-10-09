import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/server/app';
import { mockProvider, imageData } from './mock-provider';
import { productionHtmlContent } from './production-provider-fixture';
import type { ApiMode, Message } from '../src/shared/types';

let app: Awaited<ReturnType<typeof createApp>>;
let provider: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let directory: string,
  url: string,
  cookie: string,
  imageId: string,
  basicId: string,
  stubbornId: string;
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
async function send(
  content: string,
  modelId = models.get('chat-completions')!,
  reasoningEffort = 'none',
) {
  const conversation = await json('/conversations', 'POST');
  const requestId = randomUUID();
  const response = await request(`/conversations/${conversation.id}/messages`, 'POST', {
    requestId,
    modelId,
    content,
    reasoningEffort,
  });
  if (response.status !== 202) return { response, conversation, answer: undefined };
  await (await request(`/conversations/${conversation.id}/events`)).text();
  const answer = (await json(`/conversations/${conversation.id}`)).messages.find(
    (m: Message) => m.id === requestId,
  ) as Message;
  return { response, conversation, answer };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-production-trigger-'));
  provider = await mockProvider();
  app = await createApp({
    dataDir: directory,
    secret: 'production-trigger-test-secret-at-least-32',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const registration = await request('/auth/register', 'POST', {
    email: 'trigger@example.test',
    displayName: '产物触发测试',
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
    models.set(
      apiMode,
      (
        await json('/admin/models', 'POST', {
          providerId: source.id,
          name: 'production-trigger',
          label: apiMode,
          toolCalling: true,
        })
      ).id,
    );
    if (apiMode === 'chat-completions') {
      imageId = (
        await json('/admin/models', 'POST', {
          providerId: source.id,
          name: 'production-image',
          label: 'Image',
          kind: 'image',
        })
      ).id;
      basicId = (
        await json('/admin/models', 'POST', {
          providerId: source.id,
          name: 'production-basic',
          label: 'Basic',
          toolCalling: false,
        })
      ).id;
      stubbornId = (
        await json('/admin/models', 'POST', {
          providerId: source.id,
          name: 'production-stubborn',
          label: 'Stubborn',
          toolCalling: true,
        })
      ).id;
    }
  }
});
beforeEach(async () => {
  await json(`/admin/models/${imageId}`, 'PATCH', {
    enabled: true,
    vision: false,
    label: 'Image',
    userIds: [],
  });
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
  test(`${mode}: explicit image request calls configured native image model and returns real downloadable bytes`, async () => {
    const start = provider.requests.length;
    const { answer } = await send('帮我生成一个图片，内容是一只夜晚的猫', models.get(mode));
    assert.equal(answer?.status, 'complete', answer?.error ?? 'generation should complete');
    assert.equal(
      answer?.artifacts?.length,
      1,
      'text-only final response must not satisfy an image request',
    );
    assert.equal(answer.artifacts![0].mimeType, 'image/png');
    const download = await request(`/llm-production/artifacts/${answer.artifacts![0].id}/download`);
    assert.deepEqual(
      Buffer.from(await download.arrayBuffer()),
      Buffer.from(imageData.split(',')[1], 'base64'),
    );
    const calls = provider.requests.slice(start) as Array<{ model: string; tool_choice?: unknown }>;
    assert.equal(calls.filter((body) => body.model === 'production-image').length, 1);
    const llmCalls = calls.filter((body) => body.model === 'production-trigger');
    assert.equal(llmCalls.length, 2);
    assert.equal(llmCalls[0].tool_choice, mode === 'anthropic-messages' ? undefined : 'required');
    assert.equal(
      llmCalls[1].tool_choice,
      undefined,
      'completion must stop forcing calls after artifact creation',
    );
  });
}
test('the model chooses an artifact format for a webpage request without a hardcoded format requirement', async () => {
  const start = provider.requests.length;
  const { answer } = await send('帮我写一个网页计算器');
  assert.equal(answer?.status, 'complete', answer?.error ?? 'generation should complete');
  assert.equal(answer?.artifacts?.[0]?.mimeType, 'text/html');
  const firstCall = provider.requests[start] as { messages: Array<{ content: string }> };
  assert.match(firstCall.messages.at(-1)!.content, /Required artifact: 文件/);
  assert.doesNotMatch(firstCall.messages.at(-1)!.content, /format=html|web calculator/);
  assert.equal(
    await (await request(`/llm-production/artifacts/${answer!.artifacts![0].id}/download`)).text(),
    productionHtmlContent,
  );
});
test('missing, disabled and unauthorized generation prerequisites fail before paid chat or image calls', async () => {
  const assertBlocked = async (pattern: RegExp, modelId?: string) => {
    const start = provider.requests.length;
    const { response, conversation } = await send('帮我生成一个图片', modelId);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, pattern);
    assert.equal(provider.requests.length, start);
    assert.equal((await json(`/conversations/${conversation.id}`)).messages.length, 0);
  };
  await json('/llm-production/preferences', 'PATCH', { imageModelId: null });
  await assertBlocked(/图片模型/);
  await json('/llm-production/preferences', 'PATCH', { imageModelId: imageId });
  await assertBlocked(/工具调用/, basicId);
  await json(`/admin/models/${imageId}`, 'PATCH', {
    enabled: false,
    vision: false,
    label: 'Image',
    userIds: [],
  });
  await assertBlocked(/图片模型.*停用|图片模型.*授权/);
  await json('/llm-production/preferences', 'PATCH', { enabled: false });
  await assertBlocked(/启用.*生成/);

  const registration = await request('/auth/register', 'POST', {
    email: 'revoked-image@example.test',
    displayName: '撤回图片授权',
    password: 'x',
  });
  assert.equal(registration.status, 201);
  const member = (await registration.json()).user;
  for (const modelId of [models.get('chat-completions')!, imageId])
    await json(`/admin/models/${modelId}`, 'PATCH', {
      enabled: true,
      vision: false,
      label: modelId === imageId ? 'Image' : 'chat-completions',
      userIds: [member.id],
    });
  const adminCookie = cookie;
  try {
    cookie = registration.headers.get('set-cookie')!.split(';')[0];
    await json('/llm-production/preferences', 'PATCH', { enabled: true, imageModelId: imageId });
    cookie = adminCookie;
    await json(`/admin/models/${imageId}`, 'PATCH', {
      enabled: true,
      vision: false,
      label: 'Image',
      userIds: [],
    });
    cookie = registration.headers.get('set-cookie')!.split(';')[0];
    await assertBlocked(/图片模型.*授权/);
  } finally {
    cookie = adminCookie;
  }
});
test('a provider ignoring the required tool cannot persist a successful image reply', async () => {
  const start = provider.requests.length;
  const { answer } = await send('帮我生成一个图片', stubbornId);
  assert.equal(answer?.status, 'error');
  assert.match(answer?.error ?? '', /未生成|未调用.*工具/);
  assert.deepEqual(answer?.artifacts, []);
  assert.deepEqual(answer?.usage, { input: 23, output: 42, total: 65 });
  assert.equal(
    (provider.requests.slice(start) as Array<{ model: string }>).filter(
      (body) => body.model === 'production-image',
    ).length,
    0,
  );
});
test('ordinary discussion, quoted requests and code examples never force generation', async () => {
  for (const content of [
    '为什么生成图片没有调用模型？',
    '只给一个 HTML 代码示例，不要生成文件',
    '用户说“帮我生成一个图片”，这句话该怎么处理？',
    '教我怎么生成图片',
  ]) {
    const start = provider.requests.length;
    const { answer } = await send(content);
    assert.equal(answer?.status, 'complete', answer?.error ?? 'generation should complete');
    assert.deepEqual(answer?.artifacts, []);
    assert.ok(
      (provider.requests.slice(start) as Array<{ tool_choice?: unknown }>).every(
        (body) => body.tool_choice === undefined,
      ),
    );
  }
});

test('a failed image request preserves reported usage and never automatically repeats the paid call', async () => {
  const source = await json('/admin/providers', 'POST', {
    name: 'Failure fixture',
    baseUrl: provider.url,
    apiKey: 'test',
  });
  const model = await json('/admin/models', 'POST', {
    providerId: source.id,
    name: 'production-image-failure',
    label: 'Failure',
    kind: 'image',
  });
  await json('/llm-production/preferences', 'PATCH', { imageModelId: model.id });
  const start = provider.requests.length;
  const { answer } = await send('帮我生成一个图片');
  assert.equal(answer?.status, 'error');
  assert.match(answer?.error ?? '', /HTTP 502/);
  assert.deepEqual(answer?.artifacts, []);
  const calls = provider.requests.slice(start) as Array<{ model: string }>;
  assert.equal(calls.filter((body) => body.model === 'production-image-failure').length, 1);
  assert.equal(calls.filter((body) => body.model === 'production-trigger').length, 1);
  const usage = app.kernel.ctx.db.get<{ total_tokens: number; status: string }>(
    "SELECT total_tokens,status FROM usage WHERE model_name='[图片生成] production-image-failure'",
  );
  assert.equal(usage?.total_tokens, 29);
  assert.equal(usage?.status, 'error');
});
