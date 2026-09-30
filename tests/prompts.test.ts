import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app';
import { mockProvider } from './mock-provider';
import type { ApiMode } from '../src/shared/types';

let app: Awaited<ReturnType<typeof createApp>>;
let mock: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let directory: string;
let url: string;
let admin: string;
let member: string;
let memberId: string;
let cardId: string;
const modelIds = new Map<string, string>();
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
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-prompts-'));
  mock = await mockProvider();
  app = await createApp({
    dataDir: directory,
    secret: 'prompt-fixture-secret-at-least-32-characters',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = (await register('prompt-admin@example.test')).cookie;
  const registered = await register('prompt-member@example.test');
  member = registered.cookie;
  memberId = registered.user.id;
  for (const apiMode of [
    'chat-completions',
    'responses',
    'anthropic-messages',
    'jev',
  ] as ApiMode[]) {
    const provider = await json(
      '/admin/providers',
      'POST',
      {
        name: apiMode,
        baseUrl: apiMode === 'jev' ? mock.url.replace('/v1', '/jev') : mock.url,
        apiKey: 'test',
        apiMode,
      },
      admin,
    );
    for (const name of apiMode === 'anthropic-messages'
      ? ['test-text', 'broken']
      : apiMode === 'chat-completions'
        ? ['test-text', 'no-usage', 'upstream-error', 'slow']
        : apiMode === 'responses'
          ? ['test-text', 'incomplete']
          : ['test-text']) {
      const model = await json(
        '/admin/models',
        'POST',
        { providerId: provider.id, name, label: `${apiMode}-${name}` },
        admin,
      );
      modelIds.set(`${apiMode}/${name}`, model.id);
      await json(
        `/admin/models/${model.id}`,
        'PATCH',
        { enabled: true, vision: false, label: model.label ?? name, userIds: [memberId] },
        admin,
      );
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

test('prompt editing normalizes tags, preserves omitted fields and colors, and enforces private ownership', async () => {
  cardId = (
    await json('/prompts', 'POST', {
      title: ' Writing ',
      content: 'Old content',
      description: 'Short intro',
      tags: ['写作', ' Work ', 'work'],
    })
  ).id;
  await json(`/prompts/${cardId}/color`, 'PATCH', { colorSlot: 6 });
  await json(`/prompts/${cardId}`, 'PATCH', { title: 'Revised', content: 'New content' });
  const card = (await json('/prompts'))[0];
  assert.deepEqual(card, {
    id: cardId,
    title: 'Revised',
    content: 'New content',
    description: 'Short intro',
    tags: ['写作', 'Work'],
    colorSlot: 6,
  });
  for (const body of [
    { tags: ['x'.repeat(25)] },
    { tags: Array(9).fill('x') },
    { description: 'x'.repeat(161) },
    { title: ' ' },
    {},
  ])
    assert.equal((await request(`/prompts/${cardId}`, 'PATCH', body)).status, 400);
  assert.deepEqual(await json('/prompts', 'GET', undefined, admin), []);
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await request(`/prompts/${cardId}`, method, { title: 'No' }, admin)).status, 404);
    assert.equal((await request(`/prompts/${cardId}`, method, { title: 'No' }, '')).status, 401);
  }
  await json(`/prompts/${cardId}`, 'PATCH', { description: '', tags: [] });
  assert.equal((await json('/prompts'))[0].description, '');
});

test('summary preferences are account-specific and revalidate model access on every invocation', async () => {
  const input = { title: '写作', content: '请帮我润色文章' };
  const llmId = modelIds.get('chat-completions/test-text')!;
  assert.deepEqual(await json('/prompts/preferences'), { summaryModelId: null });
  assert.equal((await request('/prompts/description', 'POST', input)).status, 400);
  assert.equal(
    (
      await request('/prompts/preferences', 'PATCH', {
        summaryModelId: modelIds.get('jev/test-text'),
      })
    ).status,
    400,
  );
  await json('/prompts/preferences', 'PATCH', { summaryModelId: llmId });
  assert.deepEqual(await json('/prompts/preferences', 'GET', undefined, admin), {
    summaryModelId: null,
  });
  await json(
    `/admin/models/${llmId}`,
    'PATCH',
    { enabled: true, vision: false, label: 'Test LLM', userIds: [] },
    admin,
  );
  const count = mock.requests.length;
  assert.equal((await request('/prompts/description', 'POST', input)).status, 403);
  assert.equal(mock.requests.length, count);
  await json(
    `/admin/models/${llmId}`,
    'PATCH',
    { enabled: true, vision: false, label: 'Test LLM', userIds: [memberId] },
    admin,
  );
  const complete = await json('/prompts/description', 'POST', input);
  assert.match(complete.description, /润色/);
  assert.deepEqual(complete.usage, { input: 23, output: 42, total: 65 });
  assert.equal((await json('/prompts'))[0].description, '', 'generating a draft never saves it');
  assert.equal((await json('/conversations')).length, 0);
});

test('summary generation uses all LLM adapters and preserves missing, cumulative and failed-call usage', async () => {
  for (const [key, status, expected] of [
    ['responses/test-text', 200, { input: 23, output: 42, total: 65 }],
    ['anthropic-messages/test-text', 200, { input: 23, output: 42, total: 65 }],
    ['chat-completions/no-usage', 200, null],
    ['anthropic-messages/broken', 502, null],
    ['responses/incomplete', 502, { input: 23, output: 42, total: 65 }],
    ['chat-completions/upstream-error', 502, null],
  ] as const) {
    await json('/prompts/preferences', 'PATCH', { summaryModelId: modelIds.get(key) });
    const response = await request('/prompts/description', 'POST', {
      title: '写作',
      content: 'Summarize me',
    });
    assert.equal(response.status, status);
    const result = await response.json();
    if (status === 200) {
      assert.match(result.description, /润色/);
      assert.deepEqual(result.usage, expected);
    } else assert.ok(!JSON.stringify(result).includes('sensitive upstream'));
    const row = app.kernel.ctx.db.get<{
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      status: string;
    }>('SELECT * FROM usage WHERE user_id=? ORDER BY rowid DESC LIMIT 1', memberId)!;
    assert.deepEqual(
      [row.input_tokens, row.output_tokens, row.total_tokens],
      [expected?.input ?? null, expected?.output ?? null, expected?.total ?? null],
    );
    assert.equal(row.status, status === 200 ? 'complete' : 'error');
  }
  await json('/prompts/preferences', 'PATCH', {
    summaryModelId: modelIds.get('chat-completions/test-text'),
  });
  assert.equal(
    (
      await request('/prompts/description', 'POST', {
        title: '[empty-description]',
        content: 'test',
      })
    ).status,
    502,
  );
});

test('plugin disposal cancels generation, rejects duplicate calls and preserves cards on re-enable', async () => {
  await json('/prompts/preferences', 'PATCH', {
    summaryModelId: modelIds.get('chat-completions/slow'),
  });
  const pending = request('/prompts/description', 'POST', { title: 'Slow', content: 'test' });
  for (
    let i = 0;
    i < 100 && !app.kernel.ctx.db.get("SELECT id FROM usage WHERE status='streaming'");
    i++
  )
    await delay(10);
  assert.equal(
    (await request('/prompts/description', 'POST', { title: 'Another', content: 'test' })).status,
    409,
  );
  await json('/features/prompts', 'PATCH', { enabled: false }, admin);
  assert.equal((await pending).status, 409);
  assert.equal((await request('/prompts')).status, 404);
  assert.equal(
    app.kernel.ctx.db.get<{ status: string }>(
      'SELECT status FROM usage ORDER BY rowid DESC LIMIT 1',
    )!.status,
    'cancelled',
  );
  await json('/features/prompts', 'PATCH', { enabled: true }, admin);
  assert.equal((await json('/prompts'))[0].id, cardId);
  assert.equal(
    app.kernel.ctx.extensions.catalog().some((item) => item.id === 'prompt-description'),
    false,
  );
});
