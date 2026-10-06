import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app';
import { memoryProviderFixture } from './memory-provider-fixture';
import { digest } from '../src/features/memory/repository';
import { renderMemoryBlock } from '../src/features/extensions/memory-context';
import type {
  MemoryItem,
  MemoryOperation,
  MemoryPreparation,
  MemoryProposal,
} from '../src/shared/memory';
import type { Message } from '../src/shared/types';
import type { ContextSnapshot } from '../src/features/context-manager/types';

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;
const namespace = `memory-http-test-${randomUUID()}`;
const enabled = { skip: !databaseUrl };
let app: Awaited<ReturnType<typeof createApp>>;
let fixture: Awaited<ReturnType<typeof memoryProviderFixture>>;
let server: ReturnType<typeof createServer>;
let directory: string, base: string, admin: string, member: string, memberId: string;
let conversationId: string, groupId: string, latestUserId: string, firstTurnId: string;
const models = new Map<string, string>();
const items = new Map<string, MemoryItem>();

async function request(path: string, method = 'GET', body?: unknown, cookie = member) {
  return fetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}
async function json<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = member,
): Promise<T> {
  const response = await request(path, method, body, cookie);
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
  return result as T;
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
async function waitFor<T>(get: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await get();
    if (ready(value)) return value;
    await delay(20);
  }
  assert.fail('memory operation did not reach the expected state');
}
const m = '/memory/v1';
async function waitIndexes() {
  await waitFor(
    () => json<MemoryOperation[]>(`${m}/operations`),
    (rows) => !rows.some((x) => x.state === 'running'),
  );
}
async function chat(content: string, extra: Record<string, unknown> = {}) {
  const requestId = randomUUID();
  await json(`/conversations/${conversationId}/messages`, 'POST', {
    requestId,
    modelId: models.get('memory-llm'),
    content,
    ...extra,
  });
  await (await request(`/conversations/${conversationId}/events`)).text();
  const messages: Message[] = (await json(`/conversations/${conversationId}`)).messages;
  assert.equal(messages.at(-1)!.status, 'complete');
  latestUserId = messages.at(-2)!.id;
  return { requestId, messages };
}

before(async () => {
  if (!databaseUrl) return;
  assert.match(
    new URL(databaseUrl).pathname,
    /test/i,
    'Use a disposable database whose name contains test',
  );
  directory = await mkdtemp(join(tmpdir(), 'drift-memory-http-'));
  fixture = await memoryProviderFixture();
  app = await createApp({
    dataDir: directory,
    secret: 'memory-http-test-secret-at-least-32-chars',
    host: '127.0.0.1',
    port: 0,
    secureCookies: false,
    trustProxy: 0,
    memoryDatabaseUrl: databaseUrl,
    memoryNamespace: namespace,
  });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = (await register('memory-admin@example.test')).cookie;
  const registered = await register('memory-member@example.test');
  member = registered.cookie;
  memberId = registered.user.id;
  const provider = await json(
    '/admin/providers',
    'POST',
    {
      name: 'Memory fixture',
      baseUrl: fixture.url,
      apiKey: 'fixture-only',
      apiMode: 'chat-completions',
    },
    admin,
  );
  for (const name of ['memory-llm', 'memory-broken', 'memory-embedding', 'memory-embedding-next']) {
    const kind = name.includes('embedding') ? 'embedding' : 'llm';
    const model = await json(
      '/admin/models',
      'POST',
      { providerId: provider.id, name, label: name, kind },
      admin,
    );
    await json(
      `/admin/models/${model.id}`,
      'PATCH',
      { enabled: true, label: name, vision: false, userIds: [memberId] },
      admin,
    );
    models.set(name, model.id);
  }
});
after(async () => {
  if (!app) return;
  await waitIndexes().catch(() => {});
  await app.kernel.stop();
  // Only this randomly named test namespace is removed; never use production tables as fixtures.
  const { MemoryDatabase } = await import('../src/kernel/memory-database');
  const cleanup = new MemoryDatabase(databaseUrl);
  await cleanup.initialized();
  for (const table of [
    'memory_selections',
    'memory_embeddings',
    'memory_sources',
    'memory_versions',
    'memory_proposals',
    'memory_operations',
    'memory_scope_state',
    'memory_strategy_configs',
    'memory_preferences',
    'memory_items',
    'memory_embedding_spaces',
  ])
    await cleanup.query(`DELETE FROM ${table} WHERE namespace=$1`, [namespace]);
  await cleanup.close();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
});

test(
  'memory HTTP APIs enforce model permissions, owner isolation, schema and version checks; embedding tests expose actual dimensions',
  enabled,
  async () => {
    assert.equal((await request(`${m}/status`, 'GET', undefined, '')).status, 401);
    assert.equal((await json(`${m}/status`)).ready, true);
    const health = await fetch(`${base}/api/health/memory`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
    const strategies = await json(`${m}/strategies`);
    assert.equal(strategies[0].settingsKey, 'default');
    const defaultPrefs = await json(`${m}/preferences`);
    assert.equal(defaultPrefs.enabled, false);
    assert.deepEqual(defaultPrefs.writeModes, { user: 'confirm', group: 'auto', session: 'auto' });
    assert.equal((await request(`${m}/preferences`, 'PATCH', { enabled: true })).status, 400);
    assert.equal(
      (await request(`${m}/preferences`, 'PATCH', { embeddingModelId: models.get('memory-llm') }))
        .status,
      400,
    );
    await json(`${m}/preferences`, 'PATCH', {
      enabled: true,
      embeddingModelId: models.get('memory-embedding'),
      recallModelId: models.get('memory-llm'),
      extractModelId: models.get('memory-llm'),
    });
    const probe = await json(
      `/admin/models/${models.get('memory-embedding')}/test`,
      'POST',
      {},
      admin,
    );
    assert.equal(probe.ok, true);
    assert.equal(probe.actualDimensions, 3);
    assert.equal(probe.usage.output, null);
    assert.equal(
      (await json('/models')).some((x: { kind: string }) => x.kind === 'embedding'),
      false,
    );
    assert.equal((await json('/models?kind=embedding')).length, 2);
    let config = await json(`${m}/strategies/default/config`);
    assert.equal(
      (
        await request(`${m}/strategies/default/config`, 'PATCH', {
          version: config.version,
          config: { maxBytes: 1 },
        })
      ).status,
      400,
    );
    config = await json(`${m}/strategies/default/config`, 'PATCH', {
      version: config.version,
      config: { maxItems: 12 },
    });
    assert.equal(
      (
        await request(`${m}/strategies/default/config`, 'PATCH', {
          version: 0,
          config: { maxItems: 10 },
        })
      ).status,
      409,
    );
    const key = randomUUID();
    let saved = await json<MemoryItem>(`${m}/memories`, 'POST', {
      scope: 'user',
      kind: 'preference',
      content: '请默认使用中文回答',
      tags: ['语言'],
      idempotencyKey: key,
    });
    const duplicate = await json<MemoryItem>(`${m}/memories`, 'POST', {
      scope: 'user',
      kind: 'preference',
      content: '请默认使用中文回答',
      tags: ['语言'],
      idempotencyKey: key,
    });
    assert.equal(duplicate.id, saved.id);
    assert.equal(saved.expiresAt, null);
    assert.equal((await request(`${m}/memories/${saved.id}`, 'GET', undefined, admin)).status, 404);
    assert.equal(
      (
        await request(
          `${m}/memories/${saved.id}`,
          'PATCH',
          { version: saved.version, content: '无权编辑' },
          admin,
        )
      ).status,
      404,
    );
    assert.equal(
      (await request(`${m}/memories/${saved.id}`, 'DELETE', undefined, admin)).status,
      404,
    );
    saved = await json<MemoryItem>(`${m}/memories/${saved.id}`, 'PATCH', {
      version: saved.version,
      pinned: true,
    });
    assert.equal(
      (await request(`${m}/memories/${saved.id}`, 'PATCH', { version: 1, content: '过时版本' }))
        .status,
      409,
    );
    assert.equal(
      (
        await request(`${m}/memories`, 'POST', {
          scope: 'user',
          kind: 'fact',
          content: 'password: secret-passphrase',
        })
      ).status,
      400,
    );
    items.set('user', saved);
    await waitIndexes();
  },
);

test(
  'a completed chat injects scoped memories once, extracts evidence-backed candidates, and invalidates sources when edited',
  enabled,
  async () => {
    groupId = (await json('/conversation-groups', 'POST', { name: '记忆测试分组' })).id;
    conversationId = (await json('/conversations', 'POST', { groupId })).id;
    const outside = (await json('/conversation-groups', 'POST', { name: '其他分组' })).id;
    for (const [name, scope, scopeId, content] of [
      ['group', 'group', groupId, '本分组使用 PostgreSQL 存储记忆'],
      ['session', 'session', conversationId, '当前会话正在实现 Memory Manager'],
      ['outside', 'group', outside, '这个分组的秘密不应出现'],
    ] as const)
      items.set(
        name,
        await json<MemoryItem>(`${m}/memories`, 'POST', { scope, scopeId, kind: 'fact', content }),
      );
    await waitIndexes();
    const prepare = () =>
      json<MemoryPreparation>(`${m}/prepare-turn`, 'POST', {
        conversationId,
        current: '检索目前项目的记忆',
      });
    const initial = await prepare();
    assert.equal(initial.status, 'ready');
    assert.deepEqual(
      new Set(initial.blocks.map((x) => x.memoryId)),
      new Set(['user', 'group', 'session'].map((key) => items.get(key)!.id)),
    );
    assert.ok(
      initial.blocks.reduce((sum, block) => sum + Buffer.byteLength(renderMemoryBlock(block)), 0) <=
        6000,
    );
    assert.equal(
      (await request(`${m}/prepare-turn`, 'POST', { conversationId, current: '越权访问' }, admin))
        .status,
      404,
    );
    const state = await json(`${m}/sessions/${conversationId}/state`);
    await json(`${m}/sessions/${conversationId}/state`, 'PATCH', {
      revision: state.revision,
      selections: { [items.get('user')!.id]: 'exclude' },
    });
    assert.equal(
      (await prepare()).blocks.some((x) => x.memoryId === items.get('user')!.id),
      false,
    );
    const excluded = await json(`${m}/sessions/${conversationId}/state`);
    await json(`${m}/sessions/${conversationId}/state`, 'PATCH', {
      revision: excluded.revision,
      selections: { [items.get('user')!.id]: null },
    });
    const turn = await chat('我喜欢中文回答，项目使用中文说明；现在实现记忆功能。');
    firstTurnId = turn.requestId;
    const snapshot = await json<ContextSnapshot>(
      `/context-manager/conversations/${conversationId}/turns/${turn.requestId}`,
    );
    assert.deepEqual(
      snapshot.sections.map((x) => x.id),
      ['system', 'long-term', 'group', 'session', 'current'],
    );
    assert.equal(snapshot.sections.flatMap((x) => x.entries).filter((x) => x.memoryId).length, 3);
    const upstream = fixture.requests.findLast((x) =>
      x.messages?.at(-1)?.content.includes('<retrieved_memory'),
    )!;
    assert.ok(upstream);
    assert.ok(!JSON.stringify(upstream).includes(items.get('outside')!.content));
    assert.equal(
      snapshot.characters,
      upstream.messages!.reduce((count, message) => count + message.content.length, 0),
    );
    const extraction = await waitFor(
      () => json<MemoryOperation[]>(`${m}/operations?conversationId=${conversationId}`),
      (rows) => rows.some((x) => x.type === 'extract' && ['complete', 'error'].includes(x.state)),
    );
    const op = extraction.find((x) => x.type === 'extract')!;
    assert.equal(op.state, 'complete', op.error ?? 'extraction failed');
    assert.equal(op.facts.discarded, 1);
    assert.equal((await request(`${m}/operations/${op.id}`, 'GET', undefined, admin)).status, 404);
    const proposals = await json<MemoryProposal[]>(
      `${m}/proposals?conversationId=${conversationId}`,
    );
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].content, '用户喜欢中文回答');
    assert.ok(proposals[0].sources.some((x) => x.evidence === '我喜欢中文回答'));
    const all = await json<MemoryItem[]>(`${m}/memories`);
    assert.ok(all.some((x) => x.content === '本项目使用中文说明' && x.scope === 'group'));
    assert.ok(all.some((x) => x.content === '当前任务是实现记忆功能' && x.scope === 'session'));
    assert.equal(
      all.some((x) => x.content.includes('缺少证据')),
      false,
    );
    const badSource = {
      conversationId,
      messageId: turn.messages[0].id,
      hash: digest('tampered'),
      evidence: '不存在',
    };
    assert.equal(
      (
        await request(`${m}/proposals`, 'POST', {
          scope: 'user',
          kind: 'fact',
          content: '不能保存伪造的来源',
          sources: [badSource],
        })
      ).status,
      409,
    );
    const confirmed = await json<{ memory: MemoryItem; proposal: MemoryProposal }>(
      `${m}/proposals/${proposals[0].id}/decision`,
      'POST',
      { decision: 'approve' },
    );
    assert.equal(confirmed.proposal.state, 'approved');
    assert.equal(confirmed.memory.scope, 'user');
    assert.equal(
      (await request(`${m}/proposals/${proposals[0].id}/decision`, 'POST', { decision: 'approve' }))
        .status,
      409,
    );
    await waitIndexes();
    const usage = app.kernel.ctx.db.all<{
      model_name: string;
      input_tokens: number | null;
      output_tokens: number | null;
    }>('SELECT model_name,input_tokens,output_tokens FROM usage WHERE user_id=?', memberId);
    assert.ok(
      usage.some(
        (x) => x.model_name.includes('记忆召回') && x.input_tokens === 20 && x.output_tokens === 10,
      ),
    );
    assert.ok(
      usage.some(
        (x) =>
          x.model_name.includes('memory-embedding') &&
          x.input_tokens === 3 &&
          x.output_tokens === null,
      ),
    );
    await json(`${m}/preferences`, 'PATCH', {
      writeModes: { user: 'off', group: 'off', session: 'off' },
    });
    await chat('原问题已修改，请不要沿用先前结论。', { replaceLastMessageId: latestUserId });
    assert.equal((await json<MemoryItem>(`${m}/memories/${confirmed.memory.id}`)).status, 'review');
    const reviewed = await json<MemoryItem[]>(`${m}/memories?status=review`);
    assert.ok(reviewed.some((x) => x.content === '本项目使用中文说明'));
    const refreshed = await json<MemoryItem>(`${m}/memories/${confirmed.memory.id}`, 'PATCH', {
      version: confirmed.memory.version,
      content: '用户复核后确认仍偏好中文回答',
    });
    assert.equal(refreshed.status, 'active');
    await json(`${m}/preferences`);
    assert.equal((await json<MemoryItem>(`${m}/memories/${refreshed.id}`)).status, 'active');
    assert.equal(refreshed.sources.length, 0);
    await waitIndexes();
    await json(`${m}/memories/${items.get('user')!.id}`, 'DELETE');
    const redacted = await json<ContextSnapshot>(
      `/context-manager/conversations/${conversationId}/turns/${firstTurnId}`,
    );
    assert.ok(!JSON.stringify(redacted).includes(items.get('user')!.content));
    assert.ok(
      redacted.sections
        .flatMap((x) => x.entries)
        .some((x) => x.memoryId === items.get('user')!.id && x.content === '[记忆已删除]'),
    );
    assert.equal(
      (
        await request(`${m}/memories`, 'POST', {
          scope: 'user',
          kind: 'preference',
          content: items.get('user')!.content,
        })
      ).status,
      409,
    );
  },
);

test(
  'recall failure degrades safely, embedding changes create isolated dimensions, and disabled memory preserves chat and reconciles removed scopes',
  enabled,
  async () => {
    await json(`${m}/preferences`, 'PATCH', { recallModelId: models.get('memory-broken') });
    const fallback = await json<MemoryPreparation>(`${m}/prepare-turn`, 'POST', {
      conversationId,
      current: '查看现有记忆',
    });
    assert.equal(fallback.status, 'degraded');
    assert.ok(fallback.blocks.length > 0);
    await json(`${m}/preferences`, 'PATCH', {
      recallModelId: models.get('memory-llm'),
      embeddingModelId: models.get('memory-embedding-next'),
    });
    const empty = await json<MemoryPreparation>(`${m}/prepare-turn`, 'POST', {
      conversationId,
      current: '使用新向量空间检索',
    });
    assert.equal(empty.blocks.length, 0);
    const rebuild = await json<MemoryOperation>(`${m}/indexes/rebuild`, 'POST', {
      idempotencyKey: randomUUID(),
    });
    const complete = await waitFor(
      () => json<MemoryOperation>(`${m}/operations/${rebuild.id}`),
      (x) => ['complete', 'error'].includes(x.state),
    );
    assert.equal(complete.state, 'complete', complete.error ?? 'rebuild failed');
    assert.equal(complete.facts.dimensions, 4);
    const status = await json(`${m}/status`);
    assert.equal(status.spaces.filter((x: { state: string }) => x.state === 'active').length, 1);
    assert.ok(
      status.spaces.some(
        (x: { dimensions: number; state: string }) => x.dimensions === 4 && x.state === 'active',
      ),
    );
    assert.ok(
      (
        await json<MemoryPreparation>(`${m}/prepare-turn`, 'POST', {
          conversationId,
          current: '新向量已经回填',
        })
      ).blocks.length > 0,
    );
    await json('/features/memory', 'PATCH', { enabled: false }, admin);
    assert.equal((await request(`${m}/status`)).status, 404);
    const before = fixture.requests.length;
    await chat('记忆插件停用后的正常聊天');
    assert.equal(fixture.requests.length, before + 1);
    await json(`/conversation-groups/${groupId}`, 'DELETE');
    assert.equal(
      (await json('/conversations')).find((x: { id: string }) => x.id === conversationId).groupId,
      null,
    );
    await json('/features/memory', 'PATCH', { enabled: true }, admin);
    await json(`${m}/preferences`);
    assert.equal((await request(`${m}/memories/${items.get('group')!.id}`)).status, 404);
    assert.equal(
      (await json(`/conversations/${conversationId}`)).messages.at(-1).status,
      'complete',
    );
  },
);

test(
  'operation APIs isolate owners, retain failures and support bounded cancellation and retry',
  enabled,
  async () => {
    await waitIndexes();
    await json(`${m}/preferences`, 'PATCH', { extractModelId: models.get('memory-broken') });
    const failed = await json<MemoryOperation>(`${m}/extract`, 'POST', {
      conversationId,
      idempotencyKey: randomUUID(),
    });
    const errored = await waitFor(
      () => json<MemoryOperation>(`${m}/operations/${failed.id}`),
      (x) => x.state === 'error',
    );
    assert.ok(errored.error);
    assert.equal(
      (await request(`${m}/operations/${failed.id}/retry`, 'POST', {}, admin)).status,
      404,
    );
    await json(`${m}/preferences`, 'PATCH', { extractModelId: models.get('memory-llm') });
    const retried = await json<MemoryOperation>(`${m}/operations/${failed.id}/retry`, 'POST');
    assert.notEqual(retried.id, failed.id);
    const recovered = await waitFor(
      () => json<MemoryOperation>(`${m}/operations/${retried.id}`),
      (x) => ['complete', 'error'].includes(x.state),
    );
    assert.equal(recovered.state, 'complete', recovered.error ?? 'retry failed');
    assert.equal((await request(`${m}/operations/${retried.id}/retry`, 'POST')).status, 409);
    const source = (await json(`/conversations/${conversationId}`)).messages.at(-2) as Message;
    const proposal = await json<MemoryProposal>(`${m}/proposals`, 'POST', {
      scope: 'user',
      kind: 'episode',
      content: '用户确认保存的一条置顶备注',
      pinned: true,
      sources: [
        {
          conversationId,
          messageId: source.id,
          hash: digest(source.content),
          evidence: source.content,
        },
      ],
    });
    const approved = await json<{ memory: MemoryItem }>(
      `${m}/proposals/${proposal.id}/decision`,
      'POST',
      { decision: 'approve' },
    );
    assert.equal(approved.memory.pinned, true);
    await waitIndexes();
    await json(`${m}/memories/${approved.memory.id}`, 'DELETE');
    fixture.delays.embedding = 200;
    const rebuilding = await json<MemoryOperation>(`${m}/indexes/rebuild`, 'POST');
    assert.equal(
      (await request(`${m}/operations/${rebuilding.id}/cancel`, 'POST', {}, admin)).status,
      404,
    );
    const cancelled = await json<MemoryOperation>(
      `${m}/operations/${rebuilding.id}/cancel`,
      'POST',
    );
    assert.equal(cancelled.state, 'cancelled');
    fixture.delays.embedding = 0;
    const next = await json<MemoryOperation>(`${m}/operations/${rebuilding.id}/retry`, 'POST');
    assert.equal(
      (
        await waitFor(
          () => json<MemoryOperation>(`${m}/operations/${next.id}`),
          (x) => ['complete', 'error'].includes(x.state),
        )
      ).state,
      'complete',
    );
    assert.equal(
      (await json(`/conversations/${conversationId}`)).messages.at(-1).status,
      'complete',
    );
  },
);
