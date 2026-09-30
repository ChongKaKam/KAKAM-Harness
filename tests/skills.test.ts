import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app';
import { mockProvider } from './mock-provider';
import type { ApiMode, Message } from '../src/shared/types';
import type { Skill } from '../src/features/skills/types';
let app: Awaited<ReturnType<typeof createApp>>;
let mock: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let directory: string, url: string, admin: string, member: string, memberId: string;
const models = new Map<string, string>();
async function request(path: string, method = 'GET', body?: unknown, cookie = member) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}
async function json(path: string, method = 'GET', body?: unknown, cookie = member): Promise<any> {
  const r = await request(path, method, body, cookie);
  const result = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(result)}`);
  return result;
}
async function register(email: string) {
  const r = await request(
    '/auth/register',
    'POST',
    { email, displayName: email, password: 'x' },
    '',
  );
  assert.equal(r.status, 201);
  return { cookie: r.headers.get('set-cookie')!.split(';')[0], user: (await r.json()).user };
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-skills-'));
  mock = await mockProvider();
  app = await createApp({
    dataDir: directory,
    secret: 'skills-test-secret-with-enough-characters',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  server = createServer(app.app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = (await register('skill-admin@example.test')).cookie;
  const user = await register('skill-user@example.test');
  member = user.cookie;
  memberId = user.user.id;
  for (const apiMode of ['chat-completions', 'responses', 'anthropic-messages'] as ApiMode[]) {
    const provider = await json(
      '/admin/providers',
      'POST',
      { name: apiMode, baseUrl: mock.url, apiKey: 'test', apiMode },
      admin,
    );
    for (const name of [
      'skill-tool',
      'skill-two',
      'skill-no-usage',
      'skill-broken',
      'skill-slow',
      'skill-repeat',
      'test-text',
    ]) {
      const m = await json(
        '/admin/models',
        'POST',
        {
          providerId: provider.id,
          name,
          label: `${apiMode}/${name}`,
          toolCalling: name !== 'test-text',
        },
        admin,
      );
      await json(
        `/admin/models/${m.id}`,
        'PATCH',
        { enabled: true, vision: false, label: name, userIds: [memberId] },
        admin,
      );
      models.set(`${apiMode}/${name}`, m.id);
    }
  }
});
after(async () => {
  await app?.kernel.stop();
  if (server)
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeIdleConnections();
    });
  await mock?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const input = {
  title: '写作规则',
  content: '需要润色时，先读取 references/style.md；必要时读取 assets/example.txt。',
  description: '润色文章时使用',
  tags: ['写作'],
  files: [
    { path: 'references/style.md', content: 'RESOURCE_ONLY_SECRET：使用短句。' },
    { path: 'assets/example.txt', content: 'SECOND_RESOURCE：范例。' },
  ],
};
async function skill(): Promise<Skill> {
  return json('/skills', 'POST', input);
}
async function send(
  skill: Skill,
  name = 'skill-tool',
  mode = 'chat-completions',
  scope = 'conversation',
  content = '润色文章',
) {
  const chat = await json('/conversations', 'POST');
  const requestId = randomUUID();
  await json(`/conversations/${chat.id}/messages`, 'POST', {
    content,
    modelId: models.get(`${mode}/${name}`),
    requestId,
    skills: [{ id: skill.id, version: skill.version, scope }],
  });
  return { chat, requestId };
}
async function done(id: string): Promise<Message> {
  await (await request(`/conversations/${id}/events`)).text();
  return (await json(`/conversations/${id}`)).messages.at(-1);
}

test('Skill catalog is metadata-only; files and revisions remain private and immutable', async () => {
  const created = await skill();
  const summary = (await json('/skills?q=写作')).find((s: Skill) => s.id === created.id);
  assert.equal(summary.version, 1);
  assert.equal(summary.fileCount, 2);
  assert.equal(summary.content, undefined);
  assert.equal(summary.files, undefined);
  const updated = await json(`/skills/${created.id}`, 'PATCH', {
    version: 1,
    title: '更新标题',
    content: '新正文',
  });
  assert.equal(updated.version, 2);
  assert.equal((await json(`/skills/${created.id}?version=1`)).content, input.content);
  assert.equal(
    (await request(`/skills/${created.id}`, 'PATCH', { version: 1, content: 'stale' })).status,
    409,
  );
  for (const path of [
    '../secrets',
    '/etc/passwd',
    'references/../secret.md',
    'references//x.md',
    'scripts/run.sh',
    'references/a\\b.md',
  ])
    assert.equal(
      (await request('/skills', 'POST', { ...input, files: [{ path, content: 'x' }] })).status,
      400,
    );
  for (const path of [`/skills/${created.id}`, `/skills/${created.id}?version=1`])
    assert.equal((await request(path, 'GET', undefined, admin)).status, 404);
  assert.deepEqual(await json('/skills', 'GET', undefined, admin), []);
  assert.equal((await request(`/skills/${created.id}`, 'GET', undefined, '')).status, 401);
  const foreignChat = await json('/conversations', 'POST', undefined, admin);
  assert.equal(
    (
      await request(
        `/conversations/${foreignChat.id}/messages`,
        'POST',
        {
          content: 'x',
          modelId: models.get('responses/skill-tool'),
          skills: [{ id: created.id, version: 1 }],
        },
        admin,
      )
    ).status,
    404,
  );
});

for (const mode of ['chat-completions', 'responses', 'anthropic-messages'])
  test(`${mode}: progressive reads, opaque continuation, snapshots and exact per-call usage`, async () => {
    const created = await skill();
    const start = mock.requests.length;
    const beforeUsage = (await json('/usage')).totals.total;
    const { chat, requestId } = await send(created, 'skill-two', mode);
    const message = await done(chat.id);
    assert.equal(message.status, 'complete');
    assert.match(message.content, /SECOND_RESOURCE/);
    assert.deepEqual(message.usage, { input: 69, output: 126, total: 195 });
    assert.equal(message.calls?.length, 3);
    assert.equal(message.skillReads?.length, 3);
    assert.equal(message.skillReads?.[1].path, 'references/style.md');
    assert.equal((await json('/usage')).totals.total - beforeUsage, 195);
    const requests = mock.requests.slice(start) as any[];
    assert.equal(requests.length, 3);
    assert.ok(!JSON.stringify(requests[0]).includes('RESOURCE_ONLY_SECRET'));
    assert.ok(JSON.stringify(requests[1]).includes('RESOURCE_ONLY_SECRET'));
    if (mode === 'responses') {
      assert.equal(requests[1].store, false);
      assert.ok(requests[1].input.some((i: any) => i.encrypted_content === 'opaque-reasoning'));
      assert.ok(
        requests[1].input.some(
          (i: any) => i.type === 'function_call_output' && i.call_id === 'call-0',
        ),
      );
    } else if (mode === 'anthropic-messages') {
      const previous = requests[1].messages.at(-2).content;
      assert.equal(previous[0].signature, 'signed-thought');
      assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, 'call-0');
      assert.ok(!message.content.includes('private thought'));
    } else assert.equal(requests[1].messages.at(-1).tool_call_id, 'call-0');
    const snapshot = await (await request(`/conversations/${chat.id}/events`)).text();
    assert.ok(snapshot.includes('references/style.md'));
    const retry = await json(`/conversations/${chat.id}/messages`, 'POST', {
      requestId,
      content: 'x',
      modelId: models.get(`${mode}/skill-two`),
      skills: [{ id: created.id, version: 1 }],
    });
    assert.equal(retry.messageId, requestId);
    assert.equal(mock.requests.length, start + 3);
  });

test('conversation bindings pin versions, turn bindings expire and explicit removal stops injection', async () => {
  const created = await skill();
  const { chat } = await send(created);
  await done(chat.id);
  await json(`/skills/${created.id}`, 'PATCH', { content: 'UPDATED_ROOT', files: [] });
  assert.equal((await json(`/conversations/${chat.id}/skills`))[0].version, 1);
  const start = mock.requests.length;
  await json(`/conversations/${chat.id}/messages`, 'POST', {
    content: '继续',
    modelId: models.get('responses/skill-tool'),
  });
  await done(chat.id);
  assert.ok(!JSON.stringify(mock.requests.slice(start)).includes('UPDATED_ROOT'));
  await json(`/conversations/${chat.id}/messages`, 'POST', {
    content: '普通聊天',
    modelId: models.get('responses/test-text'),
    skills: [],
  });
  await done(chat.id);
  assert.deepEqual(await json(`/conversations/${chat.id}/skills`), []);
  assert.ok(!JSON.stringify(mock.requests.at(-1)).includes('Selected skills (JSON)'));
  const temporary = await send(created, 'skill-tool', 'chat-completions', 'turn');
  await done(temporary.chat.id);
  assert.deepEqual(await json(`/conversations/${temporary.chat.id}/skills`), []);
});

test('non-tool models support single-document skills but reject references before accepting the job', async () => {
  const single = await json('/skills', 'POST', {
    title: '简单技能',
    content: '请友好回答',
    files: [],
  });
  const result = await send(single, 'test-text');
  assert.equal((await done(result.chat.id)).status, 'complete');
  assert.ok(!JSON.stringify(mock.requests.at(-1)).includes('"tools"'));
  const created = await skill();
  const chat = await json('/conversations', 'POST');
  const start = mock.requests.length;
  assert.equal(
    (
      await request(`/conversations/${chat.id}/messages`, 'POST', {
        content: 'x',
        modelId: models.get('responses/test-text'),
        skills: [{ id: created.id, version: 1 }],
      })
    ).status,
    400,
  );
  assert.equal(mock.requests.length, start);
  assert.deepEqual((await json(`/conversations/${chat.id}`)).messages, []);
});

test('invalid paths, repeated reads and missing usage are reported without invented totals', async () => {
  const created = await skill();
  for (const name of ['skill-repeat', 'skill-no-usage', 'skill-broken']) {
    const { chat } = await send(created, name);
    const message = await done(chat.id);
    assert.equal(message.status, name === 'skill-no-usage' ? 'complete' : 'error');
    if (name === 'skill-no-usage') {
      assert.equal(message.usage, null);
      assert.equal(message.calls?.[0].usage?.total, 65);
    }
    if (name === 'skill-broken') assert.equal(message.calls?.[1].usage?.total, 65);
  }
  const { chat } = await send(created, 'skill-tool', 'responses', 'turn', '[bad-path]');
  const failed = await done(chat.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.skillReads?.length, 1);
});

test('viewer disconnect does not stop tool continuations; stop and disposal cancel work and preserve history', async () => {
  const created = await skill();
  const background = await send(created, 'skill-slow');
  const sub = new AbortController();
  const view = await fetch(`${url}/api/conversations/${background.chat.id}/events`, {
    headers: { cookie: member },
    signal: sub.signal,
  });
  const reader = view.body!.getReader();
  await reader.read();
  sub.abort();
  await reader.cancel().catch(() => {});
  assert.equal((await done(background.chat.id)).status, 'complete');
  for (const disable of [false, true]) {
    const start = mock.requests.length;
    const { chat } = await send(created, 'skill-slow');
    for (let i = 0; i < 100 && mock.requests.length < start + 2; i++) await delay(10);
    assert.equal(mock.requests.length, start + 2);
    if (disable) await json('/features/prompts', 'PATCH', { enabled: false }, admin);
    else await json(`/conversations/${chat.id}/stop`, 'POST');
    const message = await done(chat.id);
    assert.equal(message.status, disable ? 'error' : 'cancelled');
    assert.equal(message.calls?.[0].usage?.total, 65);
    assert.equal(message.calls?.[1].usage, null);
    if (disable) {
      assert.equal((await request('/skills')).status, 404);
      await json('/features/prompts', 'PATCH', { enabled: true }, admin);
      assert.equal((await json(`/skills/${created.id}`)).id, created.id);
    }
  }
  await json(`/skills/${created.id}`, 'DELETE');
  assert.equal((await request(`/skills/${created.id}`)).status, 404);
  assert.equal(
    (await json(`/conversations/${background.chat.id}`)).messages.at(-1).skillReads.length,
    2,
  );
});
