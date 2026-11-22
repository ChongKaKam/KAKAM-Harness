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
import { generationDeadline } from '../src/features/chat/generation-deadline';
import { capabilityContext } from '../src/features/extensions/capability-context';
import type { User } from '../src/shared/types';
let app: Awaited<ReturnType<typeof createApp>>;
let mock: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let config: Config;
let directory: string;
let url: string;
let admin: string;
let adminUser: User;
let member: string;
let memberId: string;
let modelId: string;
let jevId: string;
let llmProvider: string;
let jevProvider: string;
const defaultPolicy = { enabled: true, strategy: 'llm', llmModelId: null, decisionModelId: null };
const protocolModels = new Map<string, string>();
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
  const registered = await register('admin@extensions.test');
  admin = registered.cookie;
  adminUser = registered.user;
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
  protocolModels.set('responses', modelId);
  {
    const apiMode = 'anthropic-messages';
    const provider = await json('/admin/providers', 'POST', {
      name: apiMode,
      baseUrl: mock.url,
      apiKey: 'fixture',
      apiMode,
    });
    const model = await json('/admin/models', 'POST', {
      providerId: provider.id,
      name: 'test-text',
      label: apiMode,
    });
    protocolModels.set(apiMode, model.id);
  }
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
  await json('/extensions/preferences', 'PATCH', { id: 'search', mode: 'on' }, member);
  assert.equal((await json('/extensions', 'GET', undefined, member)).modes.search, 'on');
  await json('/extensions/preferences', 'PATCH', { id: 'search', mode: 'auto' }, member);
  assert.equal(
    (await request('/extensions/preferences', 'PATCH', { id: 'missing', mode: 'on' }, member))
      .status,
    404,
  );
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

test('an overflowing first reply blocks paid searches before any upstream request', async () => {
  const main = await json('/admin/models', 'POST', {
    providerId: llmProvider,
    name: 'bounded-chat',
    label: 'Bounded chat',
    toolCalling: true,
    contextWindowTokens: 16_000,
    maxOutputTokens: 1000,
  });
  const removeTool = app.kernel.ctx.extensions.registerConversationTools({
    id: 'budget-fixture',
    instructions: '',
    tools: (_user, scope) =>
      scope?.useWorkspace
        ? [
            {
              name: 'large_definition',
              description: 'x'.repeat(60_000),
              parameters: { type: 'object' },
            },
          ]
        : [],
    execute: async () => 'unused',
  });
  const upstreamCounts = () => [mock.requests.length, mock.searches.length, mock.decisions.length];
  const before = upstreamCounts();
  try {
    for (const largeHistory of [false, true]) {
      const { id } = await json('/conversations', 'POST');
      if (largeHistory) {
        removeTool();
        for (const role of ['user', 'assistant'])
          app.kernel.ctx.db.run(
            'INSERT INTO messages(id,conversation_id,role,content,images,created_at) VALUES(?,?,?,?,?,?)',
            randomUUID(),
            id,
            role,
            'history'.repeat(5000),
            '[]',
            new Date().toISOString(),
          );
      }
      await json(`/conversations/${id}/messages`, 'POST', {
        modelId: main.id,
        content: 'Verify the news.',
        extensions: { search: 'on' },
      });
      const message = await finish(id);
      assert.equal(message.status, 'error');
      assert.match(message.error!, /输入估算.*超过/);
      assert.equal(message.usage, null);
      assert.deepEqual(upstreamCounts(), before);
    }
  } finally {
    removeTool();
  }
});

test('Off is a no-op; On searches every generated query, deduplicates sources and keeps actual per-stage usage', async () => {
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

test('a slow parallel search streams a provisional answer and verifies it on the same task', async () => {
  const start = mock.searches.length;
  const task = await accepted('[harness-parallel] 解释原理并核实项目数据');
  try {
    await waitFor(() => mock.searches.length >= start + 2);
    assert.deepEqual(
      mock.searches
        .slice(start)
        .map((search) => search.query)
        .sort(),
      ['held-a', 'held-b'],
    );
    const end = Date.now() + 10000;
    let draft: Message;
    do {
      draft = (await json('/conversations/' + task.id)).messages.at(-1);
      if (draft.content.includes('待核实')) break;
      await delay(50);
    } while (Date.now() < end);
    assert.equal(draft.status, 'streaming');
    assert.match(draft.content, /待核实/);
    assert.equal(draft.id, task.body.requestId);
  } finally {
    mock.releaseSearches();
  }
  const result = await finish(task.id);
  assert.equal(result.status, 'complete');
  assert.equal(result.id, task.body.requestId);
  assert.match(result.content, /待核实。\s+根据检索结果/);
  assert.match(result.content, /https:\/\/example\.test\/docs/);
  assert.equal(result.calls?.length, 2);
  assert.equal(result.usage?.total, 130);
  assert.equal(result.harnessRun?.phase, 'done');
  assert.equal(mock.searches.length, start + 2);
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
  assert.equal(failure.status, 'complete');
  assert.equal(failure.extensions![0].fallback, 'skip');
  assert.equal(failure.extensions![0].decision, undefined);
  assert.equal(failure.extensions![0].calls[0].status, 'error');
  assert.equal(failure.extensions![0].calls[0].usage?.total, 65);
  assert.match(failure.extensions![0].error!, /结构/);
  assert.equal(failure.usage?.total, 65);
});

for (const apiMode of ['responses', 'anthropic-messages'])
  test(`Auto ${apiMode} skips failures, reports fallback and retains usage without injecting evidence`, async () => {
    await json('/admin/extensions/search', 'PATCH', {
      ...defaultPolicy,
      llmModelId: protocolModels.get(apiMode),
    });
    for (const content of ['[bad-json]', '[decision-preface]', '[query-bad-json]']) {
      const before = mock.searches.length;
      const acceptedTurn = await accepted(content, 'auto');
      const result = await finish(acceptedTurn.id);
      assert.equal(result.status, 'complete');
      assert.ok(result.content);
      const run = result.extensions![0];
      assert.equal(run.status, 'error');
      assert.equal(run.fallback, 'skip');
      assert.ok(run.error);
      assert.equal(run.calls.find((c) => c.status === 'error')?.usage?.total ?? null, 65);
      assert.equal(mock.searches.length, before);
      const answer = mock.requests.at(-1) as { input: { content: string }[] };
      assert.ok(!answer.input.at(-1)!.content.includes('Web search evidence follows'));
      const persisted = await json(`/conversations/${acceptedTurn.id}`);
      assert.equal(persisted.messages.at(-1).extensions[0].fallback, 'skip');
    }
  });

test('Claude Auto accepts fenced JSON and initial block text; output-limit failures continue chat', async () => {
  await json('/admin/extensions/search', 'PATCH', {
    ...defaultPolicy,
    llmModelId: protocolModels.get('anthropic-messages'),
  });
  for (const content of [
    '[decision-fenced] [skip-search]',
    '[decision-start-text] [skip-search]',
  ]) {
    const turn = await accepted(content, 'auto');
    const result = await finish(turn.id);
    assert.equal(result.status, 'complete');
    assert.equal(result.extensions![0].status, 'skipped');
    assert.equal(result.extensions![0].fallback, undefined);
    assert.deepEqual(result.extensions![0].decision, { enabled: false });
  }
  const turn = await accepted('[decision-output-limit]', 'auto');
  const result = await finish(turn.id);
  assert.equal(result.status, 'complete');
  assert.equal(result.extensions![0].fallback, 'skip');
  assert.match(result.extensions![0].error!, /输出上限/);
  assert.equal(result.extensions![0].calls[0].usage?.total, 65);
});

test('Claude HTTP 400 tool errors belong to the answer stage and are not masked as Auto fallback', async () => {
  const provider = await json('/admin/providers', 'POST', {
    name: 'Claude tool failure fixture',
    baseUrl: mock.url,
    apiMode: 'anthropic-messages',
    apiKey: 'fixture',
  });
  const model = await json('/admin/models', 'POST', {
    providerId: provider.id,
    name: 'tool-http-error',
    label: 'Claude tool fixture',
  });
  const auxiliary = await json('/admin/models', 'POST', {
    providerId: provider.id,
    name: 'auxiliary-http-error',
    label: 'Claude auxiliary fixture',
  });
  await json('/admin/extensions/search', 'PATCH', {
    ...defaultPolicy,
    llmModelId: auxiliary.id,
  });
  const recoverable = await accepted('hello', 'auto');
  const recovered = await finish(recoverable.id);
  assert.equal(recovered.status, 'complete');
  assert.equal(recovered.extensions![0].fallback, 'skip');
  assert.match(recovered.extensions![0].error!, /HTTP 400/);
  const auxiliaryRequest = mock.requests.find(
    (request) => (request as { model?: string }).model === 'auxiliary-http-error',
  ) as { tools?: unknown };
  assert.equal(auxiliaryRequest.tools, undefined);
  await json(`/admin/models/${model.id}`, 'PATCH', {
    enabled: true,
    vision: false,
    label: 'Claude tool fixture',
    toolCalling: true,
    userIds: [],
  });
  await json('/admin/extensions/search', 'PATCH', {
    ...defaultPolicy,
    llmModelId: protocolModels.get('anthropic-messages'),
  });
  const { id } = await json('/conversations', 'POST');
  await json(`/conversations/${id}/messages`, 'POST', {
    modelId: model.id,
    content: '[skip-search] hello',
    extensions: { search: 'auto' },
  });
  const result = await finish(id);
  assert.equal(result.status, 'error');
  assert.match(result.error!, /工具调用.*HTTP 400/);
  assert.equal(result.extensions![0].status, 'skipped');
  assert.equal(result.extensions![0].fallback, undefined);
  assert.equal(result.calls![0].status, 'error');
  const failed = mock.requests.at(-1) as { tools: unknown[]; messages: unknown[] };
  assert.ok(failed.tools.length);
});

test('actively stopping Auto cancels the chat rather than triggering fallback', async () => {
  const before = mock.searches.length;
  const turn = await accepted('[search-slow]', 'auto');
  await waitFor(() => mock.searches.length > before);
  await json(`/conversations/${turn.id}/stop`, 'POST');
  const result = await finish(turn.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.extensions![0].fallback, undefined);
});

test('oversized Jev preprocessing is reported as a validation error and skips Auto only', async () => {
  await json('/admin/extensions/search', 'PATCH', {
    ...defaultPolicy,
    strategy: 'llm-jev',
    decisionModelId: jevId,
  });
  const before = mock.decisions.length;
  const turn = await accepted('[long-decision-state]', 'auto');
  const result = await finish(turn.id);
  assert.equal(result.status, 'complete');
  assert.equal(result.extensions![0].fallback, 'skip');
  assert.match(result.extensions![0].error!, /长度/);
  assert.equal(mock.decisions.length, before);
  assert.equal(result.extensions![0].calls[0].usage?.total, 65);
});

test('auxiliary streamed text refreshes idle time without publishing checkpoints per chunk', async () => {
  const adapter = app.kernel.ctx.models.adapter('responses');
  const generate = adapter.generate;
  adapter.generate = async function* (_connection, _model, _messages, signal) {
    for (let i = 0; i < 12; i++) {
      await delay(30, undefined, { signal });
      yield { type: 'text', text: i === 11 ? '{"enabled":false}' : ' ' };
    }
    yield { type: 'usage', usage: { input: 1, output: 2, total: 3 } };
  };
  const deadline = generationDeadline(new AbortController().signal, undefined, 150, 2000);
  let checkpoints = 0;
  try {
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const prepared = await app.kernel.ctx.extensions.prepare(
      adminUser,
      app.kernel.ctx.extensions.plan(adminUser, { search: 'auto' }, modelId),
      messages,
      deadline.signal,
      () => {
        checkpoints++;
        deadline.touch();
      },
      { progress: deadline.touch },
    );
    assert.deepEqual(prepared, messages);
    assert.equal(deadline.signal.aborted, false);
    assert.ok(checkpoints < 12);
  } finally {
    deadline.close();
    adapter.generate = generate;
  }
});

test('Auto local timeout skips the capability without aborting the chat signal', async () => {
  const adapter = app.kernel.ctx.models.adapter('responses');
  const generate = adapter.generate;
  const timeout = AbortSignal.timeout;
  adapter.generate = async function* (_connection, _model, _messages, signal) {
    await delay(500, undefined, { signal });
    yield { type: 'text', text: '{"enabled":false}' };
  };
  AbortSignal.timeout = (milliseconds) => timeout(milliseconds === 120_000 ? 80 : milliseconds);
  const controller = new AbortController();
  let runs: import('../src/shared/types').ExtensionRun[] = [];
  try {
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const result = await app.kernel.ctx.extensions.prepare(
      adminUser,
      app.kernel.ctx.extensions.plan(adminUser, { search: 'auto' }, modelId),
      messages,
      controller.signal,
      (update) => {
        runs = structuredClone(update);
      },
    );
    assert.deepEqual(result, messages);
    assert.equal(controller.signal.aborted, false);
    assert.equal(runs[0].fallback, 'skip');
    assert.match(runs[0].error!, /超时/);
    assert.equal(runs[0].calls[0].status, 'error');
    assert.equal(runs[0].calls[0].usage, null);
  } finally {
    adapter.generate = generate;
    AbortSignal.timeout = timeout;
  }
});

test('long auxiliary context has a serialized budget and preserves the latest prompt boundaries', async () => {
  const { id } = await json('/conversations', 'POST');
  for (let i = 0; i < 8; i++)
    app.kernel.ctx.db.run(
      'INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)',
      randomUUID(),
      id,
      i % 2 ? 'assistant' : 'user',
      '\\"\n资料🧭'.repeat(3000),
      new Date().toISOString(),
    );
  const current = '不要联网。' + '资料'.repeat(6000) + '只分析现有材料。[skip-search]';
  const before = mock.requests.length;
  await json(`/conversations/${id}/messages`, 'POST', {
    modelId,
    content: current,
    extensions: { search: 'auto' },
  });
  const result = await finish(id);
  assert.equal(result.status, 'complete');
  const decision = mock.requests[before] as { input: { content: string }[] };
  const data = decision.input[0].content.split('\nConversation: ')[1];
  assert.ok(data.length <= 16000);
  const messages = JSON.parse(data);
  assert.ok(
    messages.every((message: { content: string }) => !/[\uD800-\uDFFF]/u.test(message.content)),
  );
  assert.ok(messages.at(-1).content.startsWith('不要联网。'));
  assert.ok(messages.at(-1).content.endsWith('只分析现有材料。[skip-search]'));
  assert.equal(messages.at(-1).truncated, true);
  assert.equal((await json(`/conversations/${id}`)).messages.at(-2).content, current);
  const withSummary = capabilityContext(
    [
      { role: 'user', content: '历史摘要开始。' + '\\"\n资料🧭'.repeat(3000) + '历史摘要结束。' },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 ? ('assistant' as const) : ('user' as const),
        content: '\\"\n资料🧭'.repeat(3000),
      })),
      { role: 'user', content: current },
    ],
    true,
  );
  assert.ok(withSummary.length <= 16000);
  const summarized = JSON.parse(withSummary);
  assert.equal(summarized.length, 7);
  assert.ok(summarized[0].content.startsWith('历史摘要开始。'));
  assert.ok(summarized[0].content.endsWith('历史摘要结束。'));
  assert.ok(summarized.at(-1).content.startsWith('不要联网。'));
  assert.ok(summarized.at(-1).content.endsWith('只分析现有材料。[skip-search]'));
  const single = [{ role: 'user' as const, content: '当前提问' }];
  assert.deepEqual(JSON.parse(capabilityContext(single, true)), single);
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
    assert.ok(!JSON.stringify(probe).includes('test-jev-key'));
    if (name === 'jev-error') {
      assert.equal(probe.diagnostics.response.status, 401);
      assert.match(probe.diagnostics.response.body, /Invalid API key/);
      assert.equal((await request(`/admin/models/${id}/test`, 'POST', {}, member)).status, 403);
    }
  }
});

test('one failed branch preserves and uses verified sources; empty search is explicitly unverified', async () => {
  const { id } = await accepted('[search-partial-error]');
  const result = await finish(id);
  assert.equal(result.status, 'complete');
  const run = result.extensions![0];
  assert.equal(run.sources.length, 2);
  assert.equal(run.calls[0].usage?.total, 65);
  assert.equal(
    run.calls.filter((call) => call.stage === '检索' && call.status === 'error').length,
    2,
  );
  assert.match(run.warning!, /HTTP 429/);
  assert.ok(!JSON.stringify(run).includes('private upstream'));
  const body = mock.requests.at(-1) as { input: { content: string }[] };
  assert.match(body.input.at(-1)!.content, /Some queries failed.*Web search evidence/s);
  const empty = await accepted('[search-empty]');
  const answer = await finish(empty.id);
  assert.equal(answer.status, 'complete');
  assert.equal(answer.extensions![0].sources.length, 0);
  assert.match(answer.content, /未找到/);
});

test('query planning can use a named document only when its version is visible to the target', async () => {
  const group = (await json('/conversation-groups', 'POST', { name: '检索授权范围' })).id;
  const a = (await json('/conversations', 'POST', { groupId: group })).id;
  const b = (await json('/conversations', 'POST', { groupId: group })).id;
  const source = '/conversations/' + a + '/workspace';
  const available = await json(source + '/documents', 'POST', {
    name: '项目依据.md',
    content: 'verified-reference-keyword',
  });
  await json(source + '/documents', 'POST', {
    name: '内部草案.md',
    content: 'unshared-reference-keyword',
  });
  await json(source + '/shares', 'POST', {
    targetConversationId: b,
    documentId: available.id,
    version: 1,
  });
  const start = mock.requests.length;
  await json('/conversations/' + b + '/messages', 'POST', {
    modelId,
    content: '用项目依据.md 和内部草案.md 中的关键词检索',
    extensions: { search: 'on' },
  });
  assert.equal((await finish(b)).status, 'complete');
  const plans = mock.requests
    .slice(start)
    .map((r) => (r as { input: { content: string }[] }).input[0].content)
    .filter((prompt) => prompt.startsWith('Generate 1 to'));
  assert.equal(plans.length, 1);
  assert.match(plans[0], /verified-reference-keyword/);
  assert.doesNotMatch(plans[0], /unshared-reference-keyword/);
});

test('only a confirmed empty search plans one new query within the configured query count', async () => {
  const start = mock.searches.length;
  const turn = await accepted('[search-empty] [followup-source]');
  const answer = await finish(turn.id);
  assert.equal(answer.status, 'complete');
  assert.deepEqual(
    mock.searches.slice(start).map((search) => search.query),
    ['empty', 'Drift alternative'],
  );
  assert.equal(answer.extensions![0].calls.filter((call) => call.stage === '补查搜索词').length, 1);
  assert.match(answer.content, /https:\/\/example\.test/);
});

test('a spoken project action during a running search is applied once without another model turn', async () => {
  const group = await json('/conversation-groups', 'POST', { name: '运行中授权' });
  const source = (await json('/conversations', 'POST', { groupId: group.id })).id;
  const target = (await json('/conversations', 'POST', { groupId: group.id })).id;
  const doc = await json('/conversations/' + source + '/workspace/documents', 'POST', {
    name: '资料.md',
    content: '已审资料',
  });
  const count = mock.searches.length;
  const messageId = randomUUID();
  await json('/conversations/' + source + '/messages', 'POST', {
    modelId,
    requestId: messageId,
    content: '[harness-parallel]',
    extensions: { search: 'on' },
  });
  const input = { messageId, requestId: randomUUID(), content: '发布“资料.md”v1到项目' };
  try {
    await waitFor(() => mock.searches.length === count + 2);
    const path = '/conversations/' + source + '/steer';
    const first = await json(path, 'POST', input);
    assert.match(first.receipt, /发布到项目/);
    assert.deepEqual(await json(path, 'POST', input), first);
    assert.equal(
      (await json('/conversations/' + target + '/workspace/documents/' + doc.id)).content,
      '已审资料',
    );
  } finally {
    mock.releaseSearches();
  }
  const answer = await finish(source);
  assert.equal(answer.harnessRun?.steering.length, 1);
  assert.equal(answer.calls?.length, 1);
});

test('a full private memory file reports the failed write and preserves the completed answer', async () => {
  const { id } = await json('/conversations', 'POST');
  const path = '/conversations/' + id;
  const view = await json(path + '/workspace');
  const memory = view.documents.find((doc: { name: string }) => doc.name === 'MEMORY.md');
  await json(path + '/workspace/documents/' + memory.id, 'PATCH', {
    baseVersion: memory.version,
    content: 'a'.repeat(8000),
  });
  await json(path + '/messages', 'POST', { modelId, content: '记住：验收结果' });
  const answer = await finish(id);
  assert.equal(answer.status, 'complete');
  assert.match(answer.content, /记忆未保存。MEMORY.md 已满/);
  assert.equal(answer.calls?.length, 1);
  assert.equal(
    (await json(path + '/workspace/documents/' + memory.id)).version,
    memory.version + 1,
  );
});

test('an unacknowledged search is never replayed and the chat reports unavailable evidence', async () => {
  const start = mock.searches.length;
  const turn = await accepted('[lost-search-receipt] 解释原理并求证');
  const result = await finish(turn.id);
  assert.equal(result.status, 'complete');
  assert.equal(result.extensions![0].status, 'error');
  assert.equal(result.extensions![0].fallback, 'skip');
  assert.match(result.content, /无法核实/);
  assert.match(result.harnessRun!.detail, /待核实/);
  assert.deepEqual(
    mock.searches.slice(start).map((search) => search.query),
    ['lost-receipt'],
  );
  assert.ok(!result.extensions![0].calls.some((call) => call.stage === '补查搜索词'));
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
    assert.equal(result.status, action === 'stop' ? 'cancelled' : 'complete');
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
  assert.equal((await json(`/conversations/${active.id}`)).messages.at(-1).status, 'error');
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
