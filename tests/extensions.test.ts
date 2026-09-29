import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import type { Message, Model, UsageData } from '../src/shared/types';
import { mockProvider } from './mock-provider';
let app: Awaited<ReturnType<typeof createApp>>;
let mock: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let config: Config;
let directory: string;
let url: string;
let admin: string;
let member: string;
let memberId: string;
let modelId: string;
let jevId: string;
let llmProvider: string;
let jevProvider: string;
const defaultPolicy = { enabled: true, strategy: 'llm', llmModelId: null, decisionModelId: null };
async function request(path: string, method = 'GET', body?: unknown, cookie = admin) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}
async function json(path: string, method = 'GET', body?: unknown, cookie = admin) {
  const response = await request(path, method, body, cookie);
  const result = await response.json();
  assert.ok(response.ok, `${path} ${response.status}: ${JSON.stringify(result)}`);
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
async function start() {
  app = await createApp(config);
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close() {
  await app.kernel.stop();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}
async function accepted(content: string, mode: 'on' | 'off' | 'auto' = 'on', cookie = admin) {
  const { id } = await json('/conversations', 'POST', {}, cookie);
  const requestId = randomUUID();
  const body = { requestId, modelId, content, extensions: { search: mode } };
  await json(`/conversations/${id}/messages`, 'POST', body, cookie);
  return { id, body };
}
async function finish(id: string, cookie = admin): Promise<Message> {
  const response = await request(`/conversations/${id}/events`, 'GET', undefined, cookie);
  assert.equal(response.status, 200);
  await response.text();
  const data = await json(`/conversations/${id}`, 'GET', undefined, cookie);
  return data.messages.at(-1);
}
async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate() && Date.now() < end) await delay(10);
  assert.ok(predicate(), 'operation did not start');
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-extensions-'));
  mock = await mockProvider();
  config = {
    dataDir: directory,
    secret: 'extensions-test-secret-with-at-least-32-characters',
    host: '127.0.0.1',
    port: 0,
    secureCookies: false,
    trustProxy: 0,
  };
  await start();
  admin = (await register('admin@extensions.test')).cookie;
  const user = await register('member@extensions.test');
  member = user.cookie;
  memberId = user.user.id;
  llmProvider = (
    await json('/admin/providers', 'POST', {
      name: 'LLM',
      baseUrl: mock.url,
      apiKey: 'test-provider-key',
    })
  ).id;
  jevProvider = (
    await json('/admin/providers', 'POST', {
      name: 'Jev',
      baseUrl: mock.url.replace('/v1', '/jev'),
      apiMode: 'jev',
      apiKey: 'test-jev-key',
    })
  ).id;
  modelId = (
    await json('/admin/models', 'POST', {
      providerId: llmProvider,
      name: 'test-text',
      label: 'LLM',
    })
  ).id;
  jevId = (
    await json('/admin/models', 'POST', {
      providerId: jevProvider,
      name: 'jev-latest',
      label: 'Jev',
      vision: true,
    })
  ).id;
  await json(`/admin/models/${modelId}`, 'PATCH', {
    enabled: true,
    vision: false,
    label: 'LLM',
    userIds: [memberId],
  });
});
beforeEach(async () => {
  await json('/features/search', 'PATCH', { enabled: true });
  await json('/admin/search', 'PATCH', {
    baseUrl: mock.url.replace('/v1', ''),
    apiKey: 'test-search-secret',
    maxQueries: 3,
    maxResults: 5,
  });
  await json('/admin/extensions/search', 'PATCH', defaultPolicy);
});
after(async () => {
  if (app) await close();
  if (mock) await mock.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('core protection, admin configuration, encrypted Search keys and account-isolated preferences', async () => {
  assert.equal((await request('/extensions', 'GET', undefined, '')).status, 401);
  assert.equal((await request('/features/extensions', 'PATCH', { enabled: false })).status, 400);
  for (const route of ['/admin/search', '/admin/extensions'])
    assert.equal((await request(route, 'GET', undefined, member)).status, 403);
  assert.equal((await request('/admin/search', 'PATCH', { apiKey: 'x' }, member)).status, 403);
  const config = await json('/admin/search');
  assert.equal(config.hasKey, true);
  assert.equal(config.apiKey, undefined);
  assert.equal(config.encryptedKey, undefined);
  const saved = app.kernel.ctx.db.get<{ value: string }>(
    'SELECT value FROM settings WHERE key=?',
    'search:config',
  )!;
  assert.ok(!saved.value.includes('test-search-secret'));
  await json('/admin/search', 'PATCH', { baseUrl: config.baseUrl, maxQueries: 3, maxResults: 5 });
  assert.equal((await json('/admin/search')).hasKey, true);
  await json('/extensions/preferences', 'PATCH', { modes: { search: 'auto' } }, member);
  assert.equal((await json('/extensions', 'GET', undefined, member)).modes.search, 'auto');
  assert.deepEqual((await json('/extensions')).modes, {});
  await json('/admin/search', 'PATCH', { apiKey: '' });
  assert.equal((await json('/extensions')).capabilities[0].ready, false);
  const { id } = await json('/conversations', 'POST');
  assert.equal(
    (
      await request(`/conversations/${id}/messages`, 'POST', {
        modelId,
        content: 'search',
        extensions: { search: 'on' },
      })
    ).status,
    400,
  );
});

test('Jev discovery, classification and saved-model probe use the native protocol, while chat rejects Jev', async () => {
  const before = mock.decisions.length;
  assert.deepEqual((await json(`/admin/providers/${jevProvider}/discover`, 'POST')).models, [
    'jev-latest',
  ]);
  assert.equal(mock.decisions.length, before);
  assert.ok(!(await json('/models')).some((m: Model) => m.id === jevId));
  const model = (await json('/models?kind=all')).find((m: Model) => m.id === jevId);
  assert.equal(model.kind, 'jev');
  assert.equal(model.vision, false);
  const probe = await json(`/admin/models/${jevId}/test`, 'POST');
  assert.equal(probe.ok, true);
  assert.equal(probe.firstTextMs, null);
  assert.equal(probe.textChunks, 0);
  assert.deepEqual(probe.usage, { input: 17, output: 3, total: 20 });
  const { id } = await json('/conversations', 'POST');
  assert.equal(
    (await request(`/conversations/${id}/messages`, 'POST', { modelId: jevId, content: 'hello' }))
      .status,
    400,
  );
});

test('Off is a no-op; On searches every generated query in sequence, deduplicates sources and keeps actual per-stage usage', async () => {
  const before = {
    search: mock.searches.length,
    llm: mock.requests.length,
    jev: mock.decisions.length,
  };
  const off = await accepted('No search', 'off');
  assert.equal((await finish(off.id)).status, 'complete');
  assert.equal(mock.searches.length, before.search);
  assert.equal(mock.decisions.length, before.jev);
  assert.equal(mock.requests.length, before.llm + 1);
  const on = await accepted('Find current facts', 'on');
  const result = await finish(on.id);
  assert.equal(result.status, 'complete');
  assert.match(result.content, /https:\/\/example.test\/docs/);
  const run = result.extensions![0];
  assert.equal(run.decision, undefined);
  assert.equal(run.status, 'complete');
  assert.deepEqual(
    mock.searches.slice(before.search).map((s) => s.query),
    run.queries,
  );
  assert.deepEqual(
    run.sources.map((s) => s.url),
    ['https://example.test/docs', 'https://example.test/source'],
  );
  assert.equal(run.calls[0].usage?.total, 65);
  assert.equal(run.calls.filter((c) => c.stage === '检索').length, 2);
  assert.ok(run.calls.filter((c) => c.stage === '检索').every((c) => c.usage === null));
  const usage: UsageData = await json('/usage');
  for (const call of run.calls)
    assert.equal(usage.rows.find((r) => r.id === call.id)?.totalTokens, call.usage?.total ?? null);
  assert.equal(result.usage?.total, 65);
  assert.equal((await request(`/conversations/${on.id}`, 'GET', undefined, member)).status, 404);
  assert.equal(
    (await request(`/conversations/${on.id}/events`, 'GET', undefined, member)).status,
    404,
  );
});

test('Auto LLM obeys strict boolean JSON for both enable and skip decisions', async () => {
  const before = mock.searches.length;
  const skip = await accepted('[skip-search] hello', 'auto');
  const skipped = await finish(skip.id);
  assert.equal(skipped.extensions![0].status, 'skipped');
  assert.deepEqual(skipped.extensions![0].decision, { enabled: false });
  assert.equal(mock.searches.length, before);
  const on = await accepted('Find current facts', 'auto');
  const result = await finish(on.id);
  assert.deepEqual(result.extensions![0].decision, { enabled: true });
  assert.equal(result.extensions![0].calls[0].stage, '自动决策');
  const invalid = await accepted('[bad-json]', 'auto');
  const failure = await finish(invalid.id);
  assert.equal(failure.status, 'error');
  assert.equal(failure.extensions![0].calls[0].status, 'error');
  assert.equal(failure.extensions![0].calls[0].usage?.total, 65);
  assert.match(failure.extensions![0].error!, /JSON/);
});

test('LLM + Jev preprocesses English, records native usage and cannot bypass per-user model grants', async () => {
  await json('/admin/extensions/search', 'PATCH', {
    ...defaultPolicy,
    strategy: 'llm-jev',
    decisionModelId: jevId,
  });
  const { id } = await json('/conversations', 'POST', {}, member);
  const body = { modelId, content: '搜索最新新闻', extensions: { search: 'auto' } };
  assert.equal((await request(`/conversations/${id}/messages`, 'POST', body, member)).status, 403);
  await json(`/admin/models/${jevId}`, 'PATCH', {
    enabled: true,
    vision: false,
    label: 'Jev',
    userIds: [memberId],
  });
  await json(`/conversations/${id}/messages`, 'POST', body, member);
  const result = await finish(id, member);
  assert.equal(result.status, 'complete');
  assert.deepEqual(
    result.extensions![0].calls.map((c) => c.stage),
    ['英文预处理', 'Jev 决策', '搜索词', '检索', '检索'],
  );
  assert.equal(result.extensions![0].calls[1].usage?.total, 20);
  const native = mock.decisions.at(-1) as {
    state: string;
    model: string;
    questions: unknown;
    messages?: unknown;
  };
  assert.match(native.state, /^[\x00-\x7F]+$/);
  assert.equal(native.model, 'jev-latest');
  assert.ok(native.questions);
  assert.equal(native.messages, undefined);
  const before = mock.searches.length;
  const skipped = await accepted('[skip-search] 你好', 'auto');
  assert.equal((await finish(skipped.id)).extensions![0].status, 'skipped');
  assert.equal(mock.searches.length, before);
  await json(`/admin/models/${jevId}`, 'PATCH', {
    enabled: false,
    vision: false,
    label: 'Jev',
    userIds: [],
  });
  assert.equal((await request(`/conversations/${id}/messages`, 'POST', body, member)).status, 403);
  await json(`/admin/models/${jevId}`, 'PATCH', {
    enabled: true,
    vision: false,
    label: 'Jev',
    userIds: [],
  });
  assert.equal(
    (await request('/admin/extensions/search', 'PATCH', { ...defaultPolicy, llmModelId: jevId }))
      .status,
    400,
  );
});

test('invalid Jev answers retain reported usage; missing usage remains null', async () => {
  for (const [name, expected, total] of [
    ['jev-invalid', false, 20],
    ['jev-no-usage', true, null],
    ['jev-error', false, null],
  ] as const) {
    const { id } = await json('/admin/models', 'POST', {
      providerId: jevProvider,
      name,
      label: name,
    });
    const probe = await json(`/admin/models/${id}/test`, 'POST');
    assert.equal(probe.ok, expected);
    assert.equal(probe.usage?.total ?? null, total);
    if (!expected) assert.ok(!JSON.stringify(probe).includes('secret upstream'));
  }
});

test('search failures preserve partial sources and reported tokens; empty search is explicitly unverified', async () => {
  const { id } = await accepted('[search-partial-error]');
  const result = await finish(id);
  assert.equal(result.status, 'error');
  assert.equal(result.content, '');
  const run = result.extensions![0];
  assert.equal(run.sources.length, 2);
  assert.equal(run.calls[0].usage?.total, 65);
  assert.equal(run.calls.at(-1)?.status, 'error');
  assert.match(run.error!, /HTTP 429/);
  assert.ok(!JSON.stringify(run).includes('private upstream'));
  const empty = await accepted('[search-empty]');
  const answer = await finish(empty.id);
  assert.equal(answer.status, 'complete');
  assert.equal(answer.extensions![0].sources.length, 0);
  assert.match(answer.content, /未找到/);
});

test('viewer disconnect and idempotent retries never repeat search, and snapshots retain sources', async () => {
  const before = mock.searches.length;
  const { id, body } = await accepted('[search-slow]');
  const viewer = new AbortController();
  const response = await fetch(`${url}/api/conversations/${id}/events`, {
    headers: { cookie: admin },
    signal: viewer.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  viewer.abort();
  await reader.cancel().catch(() => {});
  await json(`/conversations/${id}/messages`, 'POST', body);
  const result = await finish(id);
  assert.equal(result.status, 'complete');
  assert.equal(mock.searches.length, before + 1);
  const persisted = await json(`/conversations/${id}`);
  assert.deepEqual(persisted.messages.at(-1).extensions, result.extensions);
});

test('stop and plugin disposal cancel auxiliary calls; re-enable registers exactly once', async () => {
  for (const action of ['stop', 'disable']) {
    const before = mock.searches.length;
    const { id } = await accepted('[search-slow]');
    await waitFor(() => mock.searches.length > before);
    if (action === 'stop') await json(`/conversations/${id}/stop`, 'POST');
    else await json('/features/search', 'PATCH', { enabled: false });
    const result = await finish(id);
    assert.equal(result.status, action === 'stop' ? 'cancelled' : 'error');
    assert.equal(result.extensions![0].calls[0].usage?.total, 65);
    assert.equal(
      result.extensions![0].calls.at(-1)?.status,
      action === 'stop' ? 'cancelled' : 'error',
    );
    if (action === 'disable') {
      assert.equal((await request('/admin/search')).status, 404);
      assert.equal((await json('/extensions')).capabilities.length, 0);
    }
  }
  await json('/features/search', 'PATCH', { enabled: true });
  assert.equal((await json('/extensions')).capabilities.length, 1);
  assert.equal((await json('/admin/search')).hasKey, true);
});

test('shutdown persists auxiliary cancellation and restart keeps settings, preferences and historical sources', async () => {
  const completed = await accepted('Find facts');
  const original = await finish(completed.id);
  const before = mock.searches.length;
  const active = await accepted('[search-slow]');
  await waitFor(() => mock.searches.length > before);
  await close();
  await start();
  assert.equal((await json('/admin/search')).hasKey, true);
  assert.equal((await json('/extensions', 'GET', undefined, member)).modes.search, 'auto');
  assert.deepEqual(
    (await json(`/conversations/${completed.id}`)).messages.at(-1).extensions,
    original.extensions,
  );
  assert.equal((await json(`/conversations/${active.id}`)).messages.at(-1).status, 'cancelled');
  const columns = app.kernel.ctx.db.all<{ name: string }>('PRAGMA table_info(messages)');
  assert.equal(columns.filter((c) => c.name === 'extensions').length, 1);
});

test('unexpected restart marks persisted capability checkpoints as interrupted without discarding evidence', async () => {
  const { id } = await accepted('saved evidence');
  const result = await finish(id);
  const runs = structuredClone(result.extensions!);
  runs[0].status = 'running';
  runs[0].calls.at(-1)!.status = 'streaming';
  app.kernel.ctx.db.run(
    "UPDATE messages SET status='streaming',extensions=? WHERE id=?",
    JSON.stringify(runs),
    result.id,
  );
  app.kernel.ctx.db.run("UPDATE usage SET status='streaming' WHERE id=?", runs[0].calls.at(-1)!.id);
  await close();
  await start();
  const interrupted = (await json(`/conversations/${id}`)).messages.at(-1);
  assert.equal(interrupted.status, 'error');
  assert.equal(interrupted.extensions[0].status, 'error');
  assert.equal(interrupted.extensions[0].calls.at(-1).status, 'error');
  assert.deepEqual(interrupted.extensions[0].sources, result.extensions![0].sources);
});
