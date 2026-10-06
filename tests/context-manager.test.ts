import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app';
import { mockProvider, imageData } from './mock-provider';
import type { Message } from '../src/shared/types';
import type { ContextSnapshot, ContextSummary } from '../src/features/context-manager/types';

let app: Awaited<ReturnType<typeof createApp>>;
let mock: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let directory: string, url: string, admin: string, member: string, memberId: string;
const models = new Map<string, string>();
async function request(path: string, method = 'GET', body?: unknown, cookie = member) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}
async function json(path: string, method = 'GET', body?: unknown, cookie = member) {
  const response = await request(path, method, body, cookie);
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function register(email: string) {
  const response = await request(
    '/auth/register',
    'POST',
    { email, displayName: email, password: 'test' },
    '',
  );
  assert.equal(response.status, 201);
  return {
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    user: (await response.json()).user,
  };
}
async function submit(
  conversationId: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  const requestId = randomUUID();
  await json(`/conversations/${conversationId}/messages`, 'POST', {
    requestId,
    modelId: models.get('test-text'),
    content,
    ...extra,
  });
  return requestId;
}
async function done(conversationId: string): Promise<Message> {
  await (await request(`/conversations/${conversationId}/events`)).text();
  return (await json(`/conversations/${conversationId}`)).messages.at(-1);
}
const turnsPath = (id: string) => `/context-manager/conversations/${id}/turns`;
const handoffPath = (id: string) => `/context-manager/conversations/${id}/handoff`;
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await delay(10);
  assert.ok(predicate(), 'expected operation to start');
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-context-'));
  mock = await mockProvider();
  app = await createApp({
    dataDir: directory,
    secret: 'context-manager-test-secret-at-least-32-chars',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = (await register('context-admin@example.test')).cookie;
  const registered = await register('context-member@example.test');
  member = registered.cookie;
  memberId = registered.user.id;
  for (const apiMode of ['chat-completions', 'responses']) {
    const provider = await json(
      '/admin/providers',
      'POST',
      { name: apiMode, baseUrl: mock.url, apiKey: 'fixture-key', apiMode },
      admin,
    );
    for (const name of apiMode === 'responses'
      ? ['skill-two']
      : ['test-text', 'upstream-error', 'slow']) {
      const model = await json(
        '/admin/models',
        'POST',
        { providerId: provider.id, name, label: name, toolCalling: name.startsWith('skill-') },
        admin,
      );
      await json(
        `/admin/models/${model.id}`,
        'PATCH',
        { enabled: true, vision: true, label: name, userIds: [memberId] },
        admin,
      );
      models.set(name, model.id);
    }
  }
});
after(async () => {
  await app?.kernel.stop();
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  await mock?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('snapshots preserve exact sections, private ownership and replaced attempts; hand-off obeys cutoff and model authorization', async () => {
  assert.equal((await request('/context-manager/preferences', 'GET', undefined, '')).status, 401);
  const { id } = await json('/conversations', 'POST');
  const firstPrompt = '最初意图：分析架构 📚 https://example.test/design';
  const first = await submit(id, firstPrompt, {
    images: [{ name: 'reference.png', data: imageData }],
  });
  const reply = await done(id);
  const original: ContextSnapshot = await json(`${turnsPath(id)}/${first}`);
  assert.equal(original.status, 'complete');
  assert.equal(original.requestCount, 1);
  assert.deepEqual(original.usage, { input: 23, output: 42, total: 65 });
  assert.deepEqual(
    original.sections.map((part) => part.id),
    ['system', 'long-term', ...(original.memory ? ['group'] : []), 'session', 'current'],
  );
  assert.ok(
    original.sections
      .filter((part) => part.id !== 'current')
      .every((part) => part.entries.length === 0),
  );
  assert.equal(original.characters, firstPrompt.length);
  assert.equal(original.bytes, Buffer.byteLength(firstPrompt));
  assert.equal(original.imageCount, 1);
  assert.equal(
    original.sections.find((part) => part.id === 'current')!.entries[0].images[0].bytes,
    Buffer.from(imageData.split(',')[1], 'base64').length,
  );
  assert.equal(original.response, reply.content);
  assert.ok(!JSON.stringify(original).includes('base64'));
  assert.equal((await request(turnsPath(id), 'GET', undefined, admin)).status, 404);
  assert.equal((await request(`${turnsPath(id)}/${first}`, 'GET', undefined, admin)).status, 404);
  assert.equal(
    (
      await request(
        handoffPath(id),
        'POST',
        { messageId: first, modelId: models.get('test-text') },
        admin,
      )
    ).status,
    404,
  );

  const failed = await submit(id, '后来方向：实施插件', { modelId: models.get('upstream-error') });
  assert.equal((await done(id)).status, 'error');
  const previous = (await json(`/conversations/${id}`)).messages.at(-2).id;
  const retried = await submit(id, '最终方向：只做最小验证', { replaceLastMessageId: previous });
  await done(id);
  const list: ContextSummary[] = await json(turnsPath(id));
  assert.deepEqual(
    list.map((item) => item.messageId),
    [first, failed, retried],
  );
  assert.equal(list[1].status, 'error');
  assert.equal(list[1].usage, null);
  assert.equal(list[2].replacesMessageId, failed);
  const last: ContextSnapshot = await json(`${turnsPath(id)}/${retried}`);
  assert.deepEqual(
    last.sections.find((part) => part.id === 'session')!.entries.map((item) => item.content),
    [firstPrompt, reply.content],
  );
  assert.equal(
    (await json(`${turnsPath(id)}/${failed}`)).sections.find(
      (part: { id: string }) => part.id === 'current',
    ).entries[0].content,
    '后来方向：实施插件',
  );
  await json(`/conversations/${id}/messages`, 'POST', {
    requestId: retried,
    modelId: models.get('test-text'),
    content: 'duplicate',
  });
  assert.equal((await json(turnsPath(id))).length, 3);

  assert.equal((await request(handoffPath(id), 'POST', { messageId: first })).status, 400);
  await json('/context-manager/preferences', 'PATCH', { handoffModelId: models.get('test-text') });
  assert.deepEqual(await json('/context-manager/preferences', 'GET', undefined, admin), {
    handoffModelId: null,
  });
  const handoff = await json(handoffPath(id), 'POST', { messageId: first });
  assert.equal(handoff.throughMessageId, first);
  assert.match(handoff.markdown, /意图|进度/);
  assert.deepEqual(handoff.usage, original.usage);
  const handoffRequest = JSON.stringify(mock.requests.at(-1));
  assert.ok(handoffRequest.includes(firstPrompt));
  assert.ok(!handoffRequest.includes('后来方向'));
  assert.ok(!handoffRequest.includes('最终方向'));
  await json(handoffPath(id), 'POST', { messageId: retried });
  const latestRequest = JSON.stringify(mock.requests.at(-1));
  assert.ok(latestRequest.includes('后来方向'));
  assert.ok(latestRequest.includes('最终方向'));
  const usage = app.kernel.ctx.db.get<{ model_name: string; total_tokens: number }>(
    'SELECT model_name,total_tokens FROM usage WHERE user_id=? ORDER BY rowid DESC LIMIT 1',
    memberId,
  )!;
  assert.equal(usage.model_name, '[Hand-off] test-text');
  assert.equal(usage.total_tokens, 65);
  await json(
    `/admin/models/${models.get('test-text')}`,
    'PATCH',
    { enabled: true, vision: true, label: 'test-text', userIds: [] },
    admin,
  );
  const count = mock.requests.length;
  assert.equal((await request(handoffPath(id), 'POST', { messageId: first })).status, 403);
  assert.equal(mock.requests.length, count);
  await json(
    `/admin/models/${models.get('test-text')}`,
    'PATCH',
    { enabled: true, vision: true, label: 'test-text', userIds: [memberId] },
    admin,
  );
});

test('Skill context keeps visible results once; plugin disable preserves accepted chat and cancels hand-off', async () => {
  const skill = await json('/skills', 'POST', {
    title: '交接规范',
    content: '请读取 references/design.md 与 assets/status.txt [visible-tool-preface]',
    files: [
      { path: 'references/design.md', content: '资料 https://example.test/context' },
      { path: 'assets/status.txt', content: 'CURRENT_PROGRESS：已完成结构设计' },
    ],
  });
  const { id } = await json('/conversations', 'POST');
  const messageId = await submit(id, '参考 Skill 完成分析', {
    modelId: models.get('skill-two'),
    skills: [{ id: skill.id, version: 1, scope: 'turn' }],
  });
  await done(id);
  const snapshot: ContextSnapshot = await json(`${turnsPath(id)}/${messageId}`);
  const session = snapshot.sections.find((part) => part.id === 'session')!.entries;
  assert.equal(snapshot.requestCount, 3);
  assert.equal(session.filter((item) => item.label.startsWith('工具定义')).length, 1);
  assert.equal(session.filter((item) => item.role === 'tool').length, 2);
  assert.deepEqual(
    session.filter((item) => item.label.startsWith('工具续接')).map((item) => item.content),
    ['准备读取第 1 份资料。', '准备读取第 2 份资料。'],
  );
  assert.equal(session.filter((item) => item.content.includes('CURRENT_PROGRESS')).length, 1);
  assert.deepEqual(snapshot.usage, { input: 69, output: 126, total: 195 });
  assert.ok(session.some((item) => item.content.includes('Selected skills (JSON)')));
  assert.ok(!JSON.stringify(snapshot).includes('opaque-reasoning'));
  await json(handoffPath(id), 'POST', { messageId });
  assert.ok(JSON.stringify(mock.requests.at(-1)).includes('references/design.md'));
  assert.ok(JSON.stringify(mock.requests.at(-1)).includes('CURRENT_PROGRESS'));

  const slowId = await submit(id, '继续工作', { modelId: models.get('slow'), skills: [] });
  await waitFor(() => {
    const row = app.kernel.ctx.db.get<{ snapshot: string }>(
      'SELECT snapshot FROM context_snapshots WHERE message_id=?',
      slowId,
    );
    return !!row && JSON.parse(row.snapshot).requestCount === 1;
  });
  await json('/features/context-manager', 'PATCH', { enabled: false }, admin);
  assert.equal((await request(turnsPath(id))).status, 404);
  await json('/features/context-manager', 'PATCH', { enabled: true }, admin);
  assert.equal((await json(`${turnsPath(id)}/${slowId}`)).status, 'streaming');
  assert.equal((await done(id)).status, 'complete');
  assert.equal((await json(`${turnsPath(id)}/${slowId}`)).status, 'complete');

  const pending = request(handoffPath(id), 'POST', { messageId, modelId: models.get('slow') });
  await waitFor(
    () =>
      !!app.kernel.ctx.db.get(
        "SELECT id FROM usage WHERE model_name='[Hand-off] slow' AND status='streaming'",
      ),
  );
  await json('/features/context-manager', 'PATCH', { enabled: false }, admin);
  assert.equal((await pending).status, 409);
  const absent = await submit(id, '插件停用后的新轮次');
  await done(id);
  await json('/features/context-manager', 'PATCH', { enabled: true }, admin);
  assert.equal((await request(`${turnsPath(id)}/${absent}`)).status, 404);
  assert.equal((await json(turnsPath(id))).length, 2);
  assert.equal(
    app.kernel.ctx.db.get<{ status: string }>(
      "SELECT status FROM usage WHERE model_name='[Hand-off] slow' ORDER BY rowid DESC LIMIT 1",
    )!.status,
    'cancelled',
  );
});
