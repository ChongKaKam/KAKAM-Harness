import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app';
import { mockProvider, imageData } from './mock-provider';
import { defaultContextPreferences } from '../src/features/context-manager/preferences';
import type { ContextSnapshot } from '../src/features/context-manager/types';

let app: Awaited<ReturnType<typeof createApp>>;
let mock: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let directory: string, url: string, admin: string, member: string, owner: string;
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
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
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
const turnsPath = (id: string) => `/context-manager/conversations/${id}/turns`;
async function submit(id: string, content: string, model = 'test-text') {
  const messageId = randomUUID();
  await json(`/conversations/${id}/messages`, 'POST', {
    requestId: messageId,
    modelId: models.get(model),
    content,
  });
  await (await request(`/conversations/${id}/events`)).text();
  return { messageId, snapshot: (await json(`${turnsPath(id)}/${messageId}`)) as ContextSnapshot };
}
async function seed(
  image = false,
  contents = Array.from({ length: 6 }, (_, i) => `original-${i}:` + '历史证据'.repeat(300)),
) {
  const { id } = await json('/conversations', 'POST');
  const ids: string[] = [];
  for (const [i, content] of contents.entries()) {
    const messageId = randomUUID();
    ids.push(messageId);
    app.kernel.ctx.db.run(
      'INSERT INTO messages(id,conversation_id,role,content,images,created_at) VALUES(?,?,?,?,?,?)',
      messageId,
      id,
      i % 2 ? 'assistant' : 'user',
      content,
      JSON.stringify(image && i === 0 ? [{ name: 'evidence.png', data: imageData }] : []),
      new Date().toISOString(),
    );
  }
  return { id, ids, contents };
}
async function enableCompression(model = 'test-text') {
  return json('/context-manager/preferences', 'PATCH', {
    compressionEnabled: true,
    compressionModelId: models.get(model),
    compressionThreshold: 5000,
    compressionKeepTurns: 1,
    compressionMaxCharacters: 500,
  });
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 150 && !predicate(); i++) await delay(10);
  assert.ok(predicate(), 'operation did not reach expected state');
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'drift-context-processing-'));
  mock = await mockProvider();
  app = await createApp({
    dataDir: directory,
    secret: 'isolated-context-test-secret-minimum-32-characters',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = (await register('processing-admin@example.test')).cookie;
  const registered = await register('processing-member@example.test');
  member = registered.cookie;
  owner = registered.user.id;
  const provider = await json(
    '/admin/providers',
    'POST',
    { name: 'Local context mock', baseUrl: mock.url, apiKey: 'fixture' },
    admin,
  );
  const limits: Record<string, { contextWindowTokens: number; maxOutputTokens: number }> = {
    'main-million': { contextWindowTokens: 1_000_000, maxOutputTokens: 8_192 },
    'main-small': { contextWindowTokens: 12_000, maxOutputTokens: 512 },
    'summary-small': { contextWindowTokens: 2_300, maxOutputTokens: 256 },
  };
  for (const name of ['test-text', 'upstream-error', 'slow', 'no-usage', ...Object.keys(limits)]) {
    const model = await json(
      '/admin/models',
      'POST',
      { providerId: provider.id, name, label: name, ...limits[name] },
      admin,
    );
    await json(
      `/admin/models/${model.id}`,
      'PATCH',
      { enabled: true, vision: true, label: name, userIds: [owner] },
      admin,
    );
    models.set(name, model.id);
  }
});
beforeEach(async () => {
  await json('/context-manager/preferences', 'PATCH', defaultContextPreferences);
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

test('context settings merge safely, preserve legacy handoff, and validate activation and budgets', async () => {
  assert.equal((await request('/context-manager/preferences', 'GET', undefined, '')).status, 401);
  assert.deepEqual(await json('/context-manager/preferences'), defaultContextPreferences);
  app.kernel.ctx.db.run(
    'UPDATE context_preferences SET handoff_model_id=? WHERE user_id=?',
    models.get('test-text')!,
    owner,
  );
  assert.equal(
    (await json('/context-manager/preferences')).handoffModelId,
    models.get('test-text'),
  );
  assert.equal(
    (await request('/context-manager/preferences', 'PATCH', { compressionEnabled: true })).status,
    400,
  );
  assert.equal(
    (await request('/context-manager/preferences', 'PATCH', { trajectoryEnabled: true })).status,
    400,
  );
  assert.equal(
    (
      await request('/context-manager/preferences', 'PATCH', {
        compressionModelId: models.get('test-text'),
        compressionEnabled: true,
        compressionThreshold: 2000,
        compressionMaxCharacters: 2000,
      })
    ).status,
    400,
  );
  await enableCompression();
  const result = await json('/context-manager/preferences', 'PATCH', {
    handoffModelId: models.get('test-text'),
  });
  assert.equal(result.compressionEnabled, true);
  assert.equal(result.compressionThreshold, 5000);
  assert.deepEqual(
    await json('/context-manager/preferences', 'GET', undefined, admin),
    defaultContextPreferences,
  );
});

test('compression changes only provider history, reuses summaries, and incrementally compresses new evidence', async () => {
  await enableCompression();
  const { id, ids, contents } = await seed();
  const first = await submit(id, '保持当前输入原文');
  assert.equal(first.snapshot.compression?.status, 'compressed');
  assert.equal(first.snapshot.compression.compressedMessages, 4);
  assert.equal(first.snapshot.compression.retainedMessages, 2);
  const providerMessages = (mock.requests.at(-1) as { input: { content: string }[] }).input;
  assert.equal(providerMessages.length, 5);
  assert.match(providerMessages.at(-2)!.content, /当前会话\/AGENTS\.md/);
  assert.match(providerMessages[0].content, /conversation_summary/);
  assert.equal(providerMessages.at(-1)!.content, '保持当前输入原文');
  assert.deepEqual(
    providerMessages.slice(1, 3).map((message) => message.content),
    contents.slice(4),
  );
  assert.equal(
    first.snapshot.sections.find((part) => part.id === 'session')!.entries[0].label,
    '历史压缩摘要',
  );
  for (const [index, messageId] of ids.entries())
    assert.equal(
      app.kernel.ctx.db.get<{ content: string }>(
        'SELECT content FROM messages WHERE id=?',
        messageId,
      )!.content,
      contents[index],
    );
  const count = mock.requests.filter((r) =>
    JSON.stringify(r).includes('Compress conversation history'),
  ).length;
  const second = await submit(id, '继续核对设置');
  assert.equal(second.snapshot.compression?.status, 'reused');
  assert.equal(
    mock.requests.filter((r) => JSON.stringify(r).includes('Compress conversation history')).length,
    count,
  );
  const third = await submit(id, '新的详细约束'.repeat(450));
  assert.equal(third.snapshot.compression?.status, 'compressed');
  const compression = mock.requests
    .filter((r) => JSON.stringify(r).includes('Compress conversation history'))
    .at(-1) as { input: { content: string }[] };
  const prompt = compression.input[0].content;
  assert.ok(prompt.includes('previousSummary'));
  assert.ok(!prompt.includes(contents[0]));
  assert.ok(
    app.kernel.ctx.db.get(
      'SELECT conversation_id FROM context_compressions WHERE conversation_id=? AND user_id=?',
      id,
      owner,
    ),
  );
  await json(`/conversations/${id}`, 'DELETE');
  assert.equal(
    app.kernel.ctx.db.get(
      'SELECT conversation_id FROM context_compressions WHERE conversation_id=?',
      id,
    ),
    undefined,
  );
});

test('automatic compression keeps over 201 short messages intact on a configured 1M model', async () => {
  await json('/context-manager/preferences', 'PATCH', {
    compressionEnabled: true,
    compressionModelId: models.get('summary-small'),
    compressionThreshold: null,
  });
  const { id, contents } = await seed(
    false,
    Array.from({ length: 216 }, (_, i) => `turn-${i}: ` + 'short history '.repeat(20)),
  );
  const start = mock.requests.length;
  const { snapshot } = await submit(id, 'Read all the history.', 'main-million');
  assert.equal(snapshot.status, 'complete');
  const requests = mock.requests.slice(start) as {
    model: string;
    input: { content: string }[];
  }[];
  assert.deepEqual(
    requests.map((r) => r.model),
    ['main-million'],
  );
  assert.deepEqual(
    requests[0].input.slice(0, contents.length).map((m) => m.content),
    contents,
  );
  assert.equal(requests[0].input.at(-1)?.content, 'Read all the history.');
});

test('automatic threshold and a smaller compression model summarize only a fitting complete prefix once', async () => {
  await json('/context-manager/preferences', 'PATCH', {
    compressionEnabled: true,
    compressionModelId: models.get('summary-small'),
    compressionThreshold: null,
    compressionKeepTurns: 1,
    compressionMaxCharacters: 500,
  });
  const { id, contents } = await seed(
    false,
    Array.from({ length: 16 }, (_, i) => `evidence-${i}: ` + 'a'.repeat(1800)),
  );
  const start = mock.requests.length;
  const { snapshot } = await submit(id, 'Continue the design.', 'main-small');
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.compression?.status, 'compressed');
  assert.equal(snapshot.compression.thresholdUnit, 'estimatedTokens');
  const requests = mock.requests.slice(start) as {
    model: string;
    input: { content: string }[];
  }[];
  assert.deepEqual(
    requests.map((r) => r.model),
    ['summary-small', 'main-small'],
  );
  const source = JSON.parse(requests[0].input[0].content.split('\nHistory: ')[1]);
  assert.deepEqual(source.messages, [
    { role: 'user', content: contents[0] },
    { role: 'assistant', content: contents[1] },
  ]);
  assert.equal(snapshot.compression.compressedMessages, 2);
  const answer = requests[1].input;
  assert.match(answer[0].content, /conversation_summary/);
  assert.deepEqual(
    answer.slice(1, -2).map((m) => m.content),
    contents.slice(2),
  );
  assert.equal(answer.at(-1)?.content, 'Continue the design.');
  const stored = await json(`/conversations/${id}`);
  assert.deepEqual(
    stored.messages.slice(0, contents.length).map((m: { content: string }) => m.content),
    contents,
  );
});

test('scoped tool definitions can trigger compression below the raw-history threshold', async () => {
  const main = await json(
    '/admin/models',
    'POST',
    {
      providerId: (await json('/admin/providers', 'GET', undefined, admin))[0].id,
      name: 'tool-compression',
      label: 'Tool compression',
      toolCalling: true,
      contextWindowTokens: 80_000,
      maxOutputTokens: 4000,
    },
    admin,
  );
  await json(
    `/admin/models/${main.id}`,
    'PATCH',
    {
      enabled: true,
      vision: false,
      label: 'Tool compression',
      userIds: [owner],
    },
    admin,
  );
  models.set('tool-compression', main.id);
  await json('/context-manager/preferences', 'PATCH', {
    compressionEnabled: true,
    compressionModelId: models.get('test-text'),
    compressionThreshold: null,
    compressionKeepTurns: 1,
    compressionMaxCharacters: 500,
  });
  const remove = app.kernel.ctx.extensions.registerConversationTools({
    id: 'context-budget-fixture',
    instructions: '',
    tools: (_user, scope) =>
      scope?.useWorkspace
        ? [
            {
              name: 'large_schema',
              description: 'x'.repeat(150_000),
              parameters: { type: 'object' },
            },
          ]
        : [],
    execute: async () => 'unused',
  });
  try {
    const { id } = await seed(
      false,
      Array.from({ length: 12 }, () => 'a'.repeat(4000)),
    );
    const start = mock.requests.length;
    const { snapshot } = await submit(id, 'Continue.', 'tool-compression');
    assert.equal(snapshot.status, 'complete');
    assert.equal(snapshot.compression?.status, 'compressed');
    assert.equal(snapshot.compression?.thresholdUnit, 'estimatedTokens');
    const requests = mock.requests.slice(start) as {
      model: string;
      tools?: { name: string }[];
    }[];
    assert.deepEqual(
      requests.map((r) => r.model),
      ['test-text', 'tool-compression'],
    );
    assert.ok(requests[1].tools?.some((t) => t.name === 'large_schema'));
  } finally {
    remove();
  }
});

test('source changes invalidate the cache; images and recent original messages are preserved', async () => {
  await enableCompression();
  const { id, ids } = await seed();
  await submit(id, '建立摘要');
  app.kernel.ctx.db.run(
    'UPDATE messages SET content=? WHERE id=? AND conversation_id=?',
    '已修订的历史：' + '新的证据'.repeat(400),
    ids[0],
    id,
  );
  const { snapshot } = await submit(id, '检查源版本');
  assert.equal(snapshot.compression?.status, 'compressed');
  const lastCompression = mock.requests
    .filter((r) => JSON.stringify(r).includes('Compress conversation history'))
    .at(-1) as { input: { content: string }[] };
  assert.match(lastCompression.input[0].content, /"previousSummary":null/);
  assert.match(lastCompression.input[0].content, /已修订的历史/);
  const withImage = await seed(true);
  const imageTurn = await submit(withImage.id, '保留图片');
  assert.equal(imageTurn.snapshot.compression?.status, 'skipped');
  assert.equal(imageTurn.snapshot.imageCount, 1);
  assert.equal(imageTurn.snapshot.status, 'complete');
});

test('Auto Search uses configured compression before deciding, shares the summary with the answer and compresses once', async () => {
  await json('/features/search', 'PATCH', { enabled: true }, admin);
  await json(
    '/admin/search',
    'PATCH',
    {
      baseUrl: mock.url.replace('/v1', ''),
      apiKey: 'fixture',
      maxQueries: 3,
      maxResults: 5,
    },
    admin,
  );
  await json(
    '/admin/extensions/search',
    'PATCH',
    {
      enabled: true,
      strategy: 'llm',
      llmModelId: null,
      decisionModelId: null,
    },
    admin,
  );
  await enableCompression();
  const seeded = await seed();
  const before = mock.requests.length;
  try {
    const requestId = randomUUID();
    await json(`/conversations/${seeded.id}/messages`, 'POST', {
      requestId,
      modelId: models.get('test-text'),
      content: '请核实最新资料',
      extensions: { search: 'auto' },
    });
    await (await request(`/conversations/${seeded.id}/events`)).text();
    const requests = mock.requests.slice(before) as { input: { content: string }[] }[];
    assert.ok(requests[0].input[0].content.startsWith('Compress conversation history'));
    assert.equal(
      requests.filter((r) => r.input[0].content.startsWith('Compress conversation history')).length,
      1,
    );
    const decision = requests.find((r) =>
      r.input[0].content.startsWith('Decide whether to enable'),
    )!;
    const auxiliary = JSON.parse(decision.input[0].content.split('\nConversation: ')[1]);
    assert.ok(auxiliary[0].content.includes('<conversation_summary>'));
    assert.ok(!decision.input[0].content.includes('original-0:'));
    const snapshot = await json(`${turnsPath(seeded.id)}/${requestId}`);
    assert.equal(snapshot.status, 'complete');
    assert.equal(snapshot.compression.status, 'compressed');
    assert.equal(snapshot.compression.compressedMessages, 4);
    assert.ok(requests.at(-1)!.input[0].content.includes('<conversation_summary>'));
    const stored = await json(`/conversations/${seeded.id}`);
    assert.deepEqual(
      stored.messages.slice(0, 6).map((m: { content: string }) => m.content),
      seeded.contents,
    );
  } finally {
    await json(
      '/admin/search',
      'PATCH',
      { baseUrl: mock.url.replace('/v1', ''), apiKey: '', maxQueries: 3, maxResults: 5 },
      admin,
    );
  }
});

test('compression failure and model revocation fall back to original history without stopping chat', async () => {
  await enableCompression('upstream-error');
  const { id, contents } = await seed();
  const failed = await submit(id, '压缩失败仍继续');
  assert.equal(failed.snapshot.compression?.status, 'error');
  assert.equal(failed.snapshot.status, 'complete');
  assert.equal(
    failed.snapshot.sections.find((part) => part.id === 'session')!.entries[0].content,
    contents[0],
  );
  await enableCompression('no-usage');
  await json(
    `/admin/models/${models.get('no-usage')}`,
    'PATCH',
    { enabled: true, vision: true, label: 'no-usage', userIds: [] },
    admin,
  );
  const count = mock.requests.length;
  const revoked = await submit(id, '撤销辅助模型后继续');
  assert.equal(revoked.snapshot.compression?.status, 'error');
  assert.equal(revoked.snapshot.status, 'complete');
  assert.equal(mock.requests.length, count + 1);
  await json(
    `/admin/models/${models.get('no-usage')}`,
    'PATCH',
    { enabled: true, vision: true, label: 'no-usage', userIds: [owner] },
    admin,
  );
});

test('automatic and manual trajectory summaries persist separately with ownership and actual utility usage', async () => {
  const count = mock.requests.length;
  await json('/context-manager/preferences', 'PATCH', {
    trajectoryEnabled: true,
    trajectoryModelId: models.get('test-text'),
  });
  assert.equal(mock.requests.length, count);
  const { id } = await json('/conversations', 'POST');
  const { messageId } = await submit(id, '请整理记忆设置');
  const snapshot = () =>
    JSON.parse(
      app.kernel.ctx.db.get<{ snapshot: string }>(
        'SELECT snapshot FROM context_snapshots WHERE message_id=?',
        messageId,
      )!.snapshot,
    ) as ContextSnapshot;
  await waitFor(() => snapshot().trajectory?.status === 'ready');
  assert.equal(snapshot().trajectory?.title, '完善记忆与上下文管理');
  assert.equal(snapshot().prompt, '请整理记忆设置');
  assert.deepEqual(snapshot().trajectory?.usage, { input: 23, output: 42, total: 65 });
  assert.equal(
    app.kernel.ctx.db.get<{ total: number }>(
      "SELECT total_tokens AS total FROM usage WHERE user_id=? AND model_name='[轨迹摘要] test-text' ORDER BY rowid DESC LIMIT 1",
      owner,
    )!.total,
    65,
  );
  const path = `${turnsPath(id)}/${messageId}/summary`;
  assert.equal((await request(path, 'POST', {}, admin)).status, 404);
  assert.equal((await json(path, 'POST', {})).status, 'ready');
  await json('/context-manager/preferences', 'PATCH', {
    trajectoryModelId: models.get('upstream-error'),
  });
  const errorTurn = await submit(id, '失败摘要保留原回答');
  const errorSnapshot = () =>
    JSON.parse(
      app.kernel.ctx.db.get<{ snapshot: string }>(
        'SELECT snapshot FROM context_snapshots WHERE message_id=?',
        errorTurn.messageId,
      )!.snapshot,
    ) as ContextSnapshot;
  await waitFor(() => errorSnapshot().trajectory?.status === 'error');
  assert.equal(errorSnapshot().status, 'complete');
  assert.equal(
    (
      await json(`${turnsPath(id)}/${errorTurn.messageId}/summary`, 'POST', {
        modelId: models.get('test-text'),
      })
    ).status,
    'ready',
  );
  await json('/context-manager/preferences', 'PATCH', {
    trajectoryModelId: models.get('test-text'),
  });
  const bad = await submit(id, '[bad-trajectory-json]');
  await waitFor(
    () =>
      JSON.parse(
        app.kernel.ctx.db.get<{ snapshot: string }>(
          'SELECT snapshot FROM context_snapshots WHERE message_id=?',
          bad.messageId,
        )!.snapshot,
      ).trajectory?.status === 'error',
  );
  const badSnapshot: ContextSnapshot = await json(`${turnsPath(id)}/${bad.messageId}`);
  assert.deepEqual(badSnapshot.trajectory?.usage, { input: 23, output: 42, total: 65 });
});

test('plugin disable cancels compression but lets an accepted chat finish', async () => {
  await enableCompression('slow');
  const { id } = await seed();
  const messageId = randomUUID(),
    count = mock.requests.length;
  await json(`/conversations/${id}/messages`, 'POST', {
    requestId: messageId,
    modelId: models.get('test-text'),
    content: '压缩期间停用插件',
  });
  await waitFor(() =>
    mock.requests
      .slice(count)
      .some((r) => JSON.stringify(r).includes('Compress conversation history')),
  );
  await json('/features/context-manager', 'PATCH', { enabled: false }, admin);
  await (await request(`/conversations/${id}/events`)).text();
  const reply = (await json(`/conversations/${id}`)).messages.at(-1);
  assert.equal(reply.status, 'complete');
  await json('/features/context-manager', 'PATCH', { enabled: true }, admin);
  const snapshot: ContextSnapshot = await json(`${turnsPath(id)}/${messageId}`);
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.compression?.status, 'error');
});

test('trajectory interruption preserves the answer and permits a new summary generation', async () => {
  await json('/context-manager/preferences', 'PATCH', {
    trajectoryEnabled: true,
    trajectoryModelId: models.get('slow'),
  });
  const { id } = await json('/conversations', 'POST');
  const { messageId } = await submit(id, '节点摘要中断后可以重试');
  const snapshot = () =>
    JSON.parse(
      app.kernel.ctx.db.get<{ snapshot: string }>(
        'SELECT snapshot FROM context_snapshots WHERE message_id=?',
        messageId,
      )!.snapshot,
    ) as ContextSnapshot;
  await waitFor(() => snapshot().trajectory?.status === 'pending');
  const previous = snapshot().trajectory!.generationId;
  await json('/features/context-manager', 'PATCH', { enabled: false }, admin);
  await waitFor(() => snapshot().trajectory?.status === 'error');
  assert.equal(snapshot().status, 'complete');
  await json('/features/context-manager', 'PATCH', { enabled: true }, admin);
  const regenerated = await json(`${turnsPath(id)}/${messageId}/summary`, 'POST', {
    modelId: models.get('test-text'),
  });
  assert.equal(regenerated.status, 'ready');
  assert.notEqual(regenerated.generationId, previous);
  await delay(50);
  assert.equal(snapshot().trajectory?.generationId, regenerated.generationId);
  assert.equal(snapshot().trajectory?.status, 'ready');
});
