import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { MemoryDatabase } from '../src/kernel/memory-database';
import { PgMemoryRepository, digest } from '../src/features/memory/repository';
import { memoryInputSchema } from '../src/features/memory/config';

const databaseUrl = process.env.MEMORY_TEST_DATABASE_URL;
const namespace = `memory-test-${randomUUID()}`;
const owner = randomUUID(),
  other = randomUUID(),
  session = randomUUID(),
  group = randomUUID();
let db: MemoryDatabase, repository: PgMemoryRepository;
before(async () => {
  if (!databaseUrl) return;
  assert.match(
    new URL(databaseUrl).pathname,
    /test/i,
    'Use a disposable database whose name contains test',
  );
  db = new MemoryDatabase(databaseUrl);
  await db.initialized();
  assert.equal(db.ready, true, db.error ?? 'PostgreSQL fixture must be ready');
  repository = new PgMemoryRepository(db, namespace);
});
after(async () => {
  if (!db) return;
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
    await db.query(`DELETE FROM ${table} WHERE namespace=$1`, [namespace]);
  await db.close();
});
test('missing PostgreSQL configuration remains optional and does not expose a connection string', async () => {
  const empty = new MemoryDatabase();
  await empty.initialized();
  assert.equal(empty.ready, false);
  await assert.rejects(empty.query('SELECT 1'), { status: 503 });
  await empty.close();
});
test(
  'PG memory CRUD isolates owners, preserves indefinite retention and enforces versions and deletion tombstones',
  { skip: !databaseUrl },
  async () => {
    const input = memoryInputSchema.parse({
      scope: 'user',
      kind: 'preference',
      content: '希望默认使用中文回答',
      tags: ['语言'],
    });
    const saved = await repository.create(owner, input, [], true);
    assert.equal(saved.expiresAt, null);
    assert.ok(
      (await repository.list(owner, { query: '语言' })).some((item) => item.id === saved.id),
    );
    const duplicate = await repository.create(owner, input, [], true);
    assert.equal(duplicate.id, saved.id);
    await assert.rejects(repository.get(other, saved.id), { status: 404 });
    const updated = await repository.update(owner, saved.id, 1, {
      ...input,
      content: '中文回答，保持简洁',
    });
    assert.equal(updated.version, 2);
    await assert.rejects(repository.update(owner, saved.id, 1, input), { status: 409 });
    await repository.delete(owner, saved.id);
    await assert.rejects(repository.get(owner, saved.id), { status: 404 });
    await assert.rejects(
      repository.create(owner, { ...input, content: updated.content }, [], true),
      { status: 409 },
    );
    const body = (
      await db.query(
        'SELECT content FROM memory_items WHERE namespace=$1 AND owner_id=$2 AND id=$3',
        [namespace, owner, saved.id],
      )
    ).rows[0];
    assert.equal(body.content, '');
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS count FROM memory_versions WHERE namespace=$1 AND owner_id=$2 AND memory_id=$3',
          [namespace, owner, saved.id],
        )
      ).rows[0].count,
      0,
    );
  },
);
test(
  'exact pgvector recall filters owner/scope/expiry/exclusions and ignores stale content versions',
  { skip: !databaseUrl },
  async () => {
    const space = await repository.ensureSpace(owner, randomUUID(), 'fixture-space', 3);
    await repository.activateSpace(owner, space.id);
    const add = async (
      who: string,
      scope: 'user' | 'group' | 'session',
      scopeId: string | null,
      content: string,
      expiresAt: string | null = null,
    ) => {
      let saved = await repository.create(
        who,
        memoryInputSchema.parse({ scope, scopeId, kind: 'fact', content, expiresAt }),
        [],
        true,
      );
      if (scope === 'user' && !expiresAt)
        saved = await repository.admission(who, saved.id, saved.version, true);
      if (who === owner)
        await repository.storeVector(owner, saved.id, saved.version, space.id, [1, 0, 0]);
      return saved;
    };
    const global = await add(owner, 'user', null, '用户长期事实');
    const local = await add(owner, 'session', session, '当前Session事实');
    const scoped = await add(owner, 'group', group, '当前分组事实');
    const outside = await add(owner, 'group', randomUUID(), '其他分组事实');
    const expired = await add(owner, 'user', null, '已经到期的事实', '2020-01-01T00:00:00.000Z');
    await add(other, 'user', null, '另一用户的事实');
    let candidates = await repository.candidates(
      owner,
      [1, 0, 0],
      space.id,
      session,
      group,
      20,
      0.3,
    );
    assert.deepEqual(
      new Set(candidates.map((x) => x.id)),
      new Set([global.id, local.id, scoped.id]),
    );
    assert.equal(
      candidates.some((x) => x.id === outside.id || x.id === expired.id),
      false,
    );
    await repository.saveScopeState(owner, 'session', session, '', { [global.id]: 'exclude' }, 0);
    candidates = await repository.candidates(owner, [1, 0, 0], space.id, session, group, 20, 0.3);
    assert.equal(
      candidates.some((x) => x.id === global.id),
      false,
    );
    const edited = await repository.update(
      owner,
      local.id,
      local.version,
      memoryInputSchema.parse({ ...local, content: '编辑后的Session事实' }),
    );
    assert.equal(
      await repository.storeVector(owner, local.id, local.version, space.id, [1, 0, 0]),
      false,
    );
    assert.equal(
      (await repository.candidates(owner, [1, 0, 0], space.id, session, group, 20, 0.3)).some(
        (x) => x.id === edited.id,
      ),
      false,
    );
    const second = await repository.ensureSpace(owner, randomUUID(), 'another-space', 3);
    assert.equal(
      (await repository.candidates(owner, [1, 0, 0], second.id, session, group, 20, 0.3)).length,
      0,
    );
  },
);
test(
  'operation idempotency survives PostgreSQL JSONB key order and rejects changed input',
  { skip: !databaseUrl },
  async () => {
    const key = randomUUID();
    const first = await repository.beginOperation(
      owner,
      'fixture',
      'default',
      { messageId: 'm', conversationId: 'c', nested: { z: 1, a: 2 } },
      key,
    );
    const second = await repository.beginOperation(
      owner,
      'fixture',
      'default',
      { nested: { a: 2, z: 1 }, conversationId: 'c', messageId: 'm' },
      key,
    );
    assert.equal(second.created, false);
    assert.equal(second.operation.id, first.operation.id);
    await assert.rejects(
      repository.beginOperation(owner, 'fixture', 'default', { messageId: 'changed' }, key),
      { status: 409 },
    );
  },
);
test(
  'scope state optimistic concurrency rejects one simultaneous initial update',
  { skip: !databaseUrl },
  async () => {
    const id = randomUUID();
    const results = await Promise.allSettled([
      repository.saveScopeState(owner, 'session', id, 'one', {}, 0),
      repository.saveScopeState(owner, 'session', id, 'two', {}, 0),
    ]);
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(results.filter((x) => x.status === 'rejected').length, 1);
  },
);

test(
  'long-term admission is explicit, versioned, and withdrawn or edited items cannot retain vectors',
  { skip: !databaseUrl },
  async () => {
    const who = randomUUID();
    const input = memoryInputSchema.parse({
      scope: 'user',
      kind: 'fact',
      content: '待审核的长期事实',
    });
    const pending = await repository.create(who, input, [], true);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.admittedAt, null);
    const space = await repository.ensureSpace(who, randomUUID(), 'admission-test', 3);
    assert.equal(
      await repository.storeVector(who, pending.id, pending.version, space.id, [1, 0, 0]),
      false,
    );
    assert.deepEqual(await repository.candidates(who, [1, 0, 0], space.id, null, null, 10, 0), []);
    await assert.rejects(repository.admission(other, pending.id, pending.version, true), {
      status: 404,
    });
    await assert.rejects(repository.admission(who, pending.id, pending.version + 1, true), {
      status: 409,
    });
    const active = await repository.admission(who, pending.id, pending.version, true);
    assert.equal(active.status, 'active');
    assert.ok(active.admittedAt);
    const duplicate = await repository.admission(who, active.id, active.version, true);
    assert.equal(duplicate.admittedAt, active.admittedAt);
    assert.equal(duplicate.version, active.version);
    assert.equal(
      await repository.storeVector(who, active.id, active.version, space.id, [1, 0, 0]),
      true,
    );
    const metadata = await repository.update(who, active.id, active.version, {
      ...input,
      pinned: true,
    });
    assert.equal(metadata.status, 'active');
    assert.equal(metadata.admittedAt, active.admittedAt);
    const edited = await repository.update(who, active.id, metadata.version, {
      ...input,
      content: '修改后需要重新纳入',
    });
    assert.equal(edited.status, 'pending');
    assert.equal(edited.admittedAt, null);
    assert.equal(
      await repository.storeVector(who, edited.id, edited.version, space.id, [1, 0, 0]),
      false,
    );
    const readmitted = await repository.admission(who, edited.id, edited.version, true);
    const withdrawn = await repository.admission(who, readmitted.id, readmitted.version, false);
    assert.equal(withdrawn.status, 'pending');
    assert.equal(withdrawn.admittedAt, null);
    assert.equal(withdrawn.content, edited.content);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM memory_versions WHERE namespace=$1 AND owner_id=$2 AND memory_id=$3',
          [namespace, who, pending.id],
        )
      ).rows[0].n,
      5,
    );
  },
);
test(
  'remember confirmation and cancellation serialize on the preview; duplicate confirms do not create extra records',
  { skip: !databaseUrl },
  async () => {
    const who = randomUUID();
    const input = memoryInputSchema.parse({
      scope: 'user',
      kind: 'episode',
      content: '并发确认的摘要',
    });
    const started = await repository.beginOperation(who, 'remember', 'default', {});
    await repository.finishOperation(who, started.operation.id, 'complete', {
      preview: { content: input.content },
    });
    const confirmations = await Promise.all([
      repository.confirmRemember(who, started.operation.id, input, [], 'same-confirmation'),
      repository.confirmRemember(who, started.operation.id, input, [], 'same-confirmation'),
    ]);
    assert.equal(confirmations[0].id, confirmations[1].id);
    assert.equal(confirmations[0].status, 'pending');
    await repository.cancelRemember(who, started.operation.id);
    const complete = await repository.getOperation(who, started.operation.id);
    assert.equal(complete.state, 'complete');
    assert.equal(complete.facts.memoryId, confirmations[0].id);
    await assert.rejects(
      repository.confirmRemember(who, started.operation.id, input, [], 'changed-confirmation'),
      { status: 409 },
    );
    for (let i = 0; i < 6; i++) {
      const preview = await repository.beginOperation(who, 'remember', 'default', {});
      await repository.finishOperation(who, preview.operation.id, 'complete', {
        preview: { content: `竞态摘要${i}` },
      });
      const value = { ...input, content: `竞态摘要${i}` };
      const results = await Promise.allSettled([
        repository.confirmRemember(who, preview.operation.id, value, [], `race-${i}`),
        repository.cancelRemember(who, preview.operation.id),
      ]);
      const operation = await repository.getOperation(who, preview.operation.id);
      if (results[0].status === 'fulfilled') {
        assert.equal(operation.state, 'complete');
        assert.equal(operation.facts.memoryId, results[0].value.id);
      } else {
        assert.equal(operation.state, 'cancelled');
        assert.equal((await repository.list(who, { query: value.content })).length, 0);
      }
    }
  },
);
test(
  'approving a duplicate pending proposal cannot admit a concurrent edit of different content',
  { skip: !databaseUrl },
  async () => {
    const who = randomUUID();
    const input = memoryInputSchema.parse({
      scope: 'user',
      kind: 'fact',
      content: '候选准备纳入的正文 A',
    });
    const pending = await repository.create(who, input, [], false);
    const proposal = await repository.saveProposal(who, { ...input, sources: [] });
    let selected!: () => void, resume!: () => void;
    const didSelect = new Promise<void>((resolve) => {
      selected = resolve;
    });
    const canResume = new Promise<void>((resolve) => {
      resume = resolve;
    });
    // Pause after the real PostgreSQL dedupe read, before approval can write.
    // The concurrent edit uses a separate real connection and must wait on the row lock.
    const gated = new PgMemoryRepository(
      {
        query: db.query.bind(db),
        transaction: (work: (client: PoolClient) => Promise<unknown>) =>
          db.transaction(async (client) => {
            const wrapped = new Proxy(client, {
              get(target, key) {
                if (key !== 'query') return Reflect.get(target, key, target);
                return async (sql: string, values: unknown[]) => {
                  const result = await target.query(sql, values);
                  if (sql.startsWith('SELECT id,status FROM memory_items') && values[1] === who) {
                    selected();
                    await canResume;
                  }
                  return result;
                };
              },
            });
            return work(wrapped);
          }),
      } as unknown as MemoryDatabase,
      namespace,
    );
    const approving = gated.decideProposal(who, proposal.id, true);
    await didSelect;
    const editing = repository.update(who, pending.id, pending.version, {
      ...input,
      content: '尚未被用户纳入的正文 B',
    });
    // Attach a rejection observer immediately; the result is asserted after releasing approval.
    const editResult = editing.then(
      (value) => ({ state: 'edited' as const, value }),
      (error) => ({ state: 'rejected' as const, error }),
    );
    let observed: string;
    try {
      observed = await Promise.race([
        editResult.then((result) => result.state),
        delay(100).then(() => 'blocked'),
      ]);
    } finally {
      resume();
    }
    const approved = await approving;
    const edit = await editResult;
    assert.equal(observed, 'blocked');
    assert.equal(approved!.content, input.content);
    assert.equal(approved!.status, 'active');
    assert.equal(edit.state, 'rejected');
    if (edit.state === 'rejected') assert.equal(edit.error.status, 409);
    assert.equal((await repository.get(who, pending.id)).content, input.content);
  },
);
test(
  'dedupe confirmation returns 409 when a concurrent edit moves the matching key before its lock',
  { skip: !databaseUrl },
  async () => {
    for (const mode of ['proposal', 'remember'] as const) {
      const who = randomUUID();
      const input = memoryInputSchema.parse({
        scope: 'user',
        kind: 'episode',
        content: `${mode} 原摘要 A`,
      });
      const pending = await repository.create(who, input, [], false);
      const gated = new PgMemoryRepository(
        {
          query: db.query.bind(db),
          transaction: (work: (client: PoolClient) => Promise<unknown>) =>
            db.transaction(async (client) => {
              const wrapped = new Proxy(client, {
                get(target, key) {
                  if (key !== 'query') return Reflect.get(target, key, target);
                  return async (sql: string, values: unknown[]) => {
                    if (sql.startsWith('SELECT id,status FROM memory_items') && values[1] === who)
                      await repository.update(who, pending.id, pending.version, {
                        ...input,
                        content: `${mode} 新摘要 B`,
                      });
                    return target.query(sql, values);
                  };
                },
              });
              return work(wrapped);
            }),
        } as unknown as MemoryDatabase,
        namespace,
      );
      if (mode === 'proposal') {
        const proposal = await repository.saveProposal(who, { ...input, sources: [] });
        await assert.rejects(gated.decideProposal(who, proposal.id, true), { status: 409 });
        assert.equal((await repository.getProposal(who, proposal.id)).state, 'pending');
      } else {
        const operation = await repository.beginOperation(who, 'remember', 'default', {});
        await repository.finishOperation(who, operation.operation.id, 'complete', {
          preview: { content: input.content },
        });
        await assert.rejects(
          gated.confirmRemember(who, operation.operation.id, input, [], 'changed-key'),
          { status: 409 },
        );
        assert.equal(
          (await repository.getOperation(who, operation.operation.id)).facts.memoryId,
          undefined,
        );
      }
      const changed = await repository.get(who, pending.id);
      assert.equal(changed.content, `${mode} 新摘要 B`);
      assert.equal(changed.status, 'pending');
      assert.equal(changed.admittedAt, null);
    }
  },
);
test(
  'idle retention clears only scoped data and explicit expiry without expiring old indefinite user memories',
  { skip: !databaseUrl },
  async () => {
    const who = randomUUID(),
      groupId = randomUUID(),
      sessionId = randomUUID();
    await repository.savePreferences(who, {
      enabled: false,
      strategyId: 'default',
      embeddingModelId: null,
      recallModelId: null,
      extractModelId: null,
      writeModes: { user: 'confirm', group: 'auto', session: 'auto' },
      retentionDays: { group: 14, session: 30 },
    });
    const durable = await repository.create(
      who,
      memoryInputSchema.parse({ scope: 'user', kind: 'fact', content: '长期保留的旧画像' }),
      [],
      true,
    );
    const project = await repository.create(
      who,
      memoryInputSchema.parse({
        scope: 'group',
        scopeId: groupId,
        kind: 'task',
        content: '闲置项目阶段状态',
      }),
      [],
      false,
    );
    const current = await repository.create(
      who,
      memoryInputSchema.parse({
        scope: 'session',
        scopeId: sessionId,
        kind: 'task',
        content: 'Session仍在保留窗口内',
      }),
      [],
      false,
    );
    const explicit = await repository.create(
      who,
      memoryInputSchema.parse({
        scope: 'user',
        kind: 'fact',
        content: '明确到期的用户事实',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
      [],
      true,
    );
    await repository.touch(who, sessionId, groupId);
    await db.query(
      `UPDATE memory_scope_state SET last_activity_at=now()-interval '20 days' WHERE namespace=$1 AND owner_id=$2`,
      [namespace, who],
    );
    await db.query(
      `UPDATE memory_items SET created_at=now()-interval '2 years',updated_at=now()-interval '2 years' WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
      [namespace, who, durable.id],
    );
    const expired = await repository.expired({ group: 30, session: 30 }, who);
    assert.deepEqual(new Set(expired.map((x) => x.id)), new Set([project.id, explicit.id]));
    assert.equal(
      expired.some((x) => x.id === durable.id || x.id === current.id),
      false,
    );
    const scopes = await repository.expiredScopes({ group: 30, session: 30 }, who);
    assert.deepEqual(scopes, [{ owner: who, scope: 'group', id: groupId }]);
    const source = {
      conversationId: sessionId,
      messageId: randomUUID(),
      hash: digest('来源用户文本'),
      evidence: '用户文本',
    };
    await repository.saveProposal(who, {
      scope: 'group',
      scopeId: groupId,
      kind: 'fact',
      content: '待确认的项目状态',
      sources: [source],
      expiresAt: null,
    });
    await repository.saveScopeState(
      who,
      'session',
      sessionId,
      'scope摘要',
      { [durable.id]: 'exclude' },
      1,
    );
    for (const record of expired) await repository.delete(who, record.id);
    await repository.removeScopeData(who, 'group', groupId);
    assert.equal((await repository.proposals(who)).length, 0);
    assert.equal((await repository.scopeState(who, 'group', groupId)).revision, 0);
    assert.equal((await repository.get(who, durable.id)).expiresAt, null);
    assert.equal((await repository.get(who, current.id)).content, 'Session仍在保留窗口内');
  },
);

test(
  'source invalidation excludes derived records and tombstone deletion erases pending proposals, history and vectors',
  { skip: !databaseUrl },
  async () => {
    const who = randomUUID(),
      conversationId = randomUUID(),
      messageId = randomUUID();
    const source = { conversationId, messageId, hash: digest('偏好中文'), evidence: '中文' };
    const input = memoryInputSchema.parse({
      scope: 'user',
      kind: 'preference',
      content: '来源有证据的中文偏好',
    });
    const created = await repository.create(who, input, [source], true);
    const memory = await repository.admission(who, created.id, created.version, true);
    const pending = await repository.saveProposal(who, { ...input, sources: [source] });
    const space = await repository.ensureSpace(who, randomUUID(), 'cleanup-space', 3);
    await repository.storeVector(who, memory.id, memory.version, space.id, [1, 0, 0]);
    assert.deepEqual(
      await repository.sourceRows(who),
      [source].map(({ evidence, ...rest }) => rest),
    );
    const invalidated = await repository.invalidate(who, conversationId, messageId);
    assert.deepEqual(invalidated, [memory.id]);
    assert.equal((await repository.get(who, memory.id)).status, 'review');
    assert.equal((await repository.getProposal(who, pending.id)).state, 'invalidated');
    assert.equal(
      (await repository.candidates(who, [1, 0, 0], space.id, conversationId, null, 20, 0)).length,
      0,
    );
    const edited = await repository.update(who, memory.id, memory.version, {
      ...input,
      content: '用户重新确认并编辑后的偏好',
    });
    await repository.storeVector(who, memory.id, edited.version, space.id, [1, 0, 0]);
    await repository.delete(who, memory.id);
    assert.deepEqual(await repository.proposals(who, 'all'), []);
    assert.deepEqual(await repository.sourceRows(who), []);
    for (const table of ['memory_versions', 'memory_embeddings', 'memory_sources'])
      assert.equal(
        (
          await db.query(
            `SELECT count(*)::int AS count FROM ${table} WHERE namespace=$1 AND owner_id=$2 AND memory_id=$3`,
            [namespace, who, memory.id],
          )
        ).rows[0].count,
        0,
      );
  },
);

test(
  'namespace isolation preserves another manager operations and invalid vectors cannot enter a space',
  { skip: !databaseUrl },
  async () => {
    const secondNamespace = `${namespace}-other`,
      otherRepository = new PgMemoryRepository(db, secondNamespace);
    try {
      const running = await otherRepository.beginOperation(owner, 'extract', 'default', {
        conversationId: session,
      });
      await repository.interruptOperations();
      assert.equal(
        (await otherRepository.getOperation(owner, running.operation.id)).state,
        'running',
      );
      const pending = await repository.create(
        owner,
        memoryInputSchema.parse({ scope: 'user', kind: 'fact', content: '严格向量验证测试内容' }),
        [],
        true,
      );
      const memory = await repository.admission(owner, pending.id, pending.version, true);
      const space = await repository.ensureSpace(owner, randomUUID(), 'strict-vector-space', 3);
      for (const vector of [
        [1, 0],
        [0, 0, 0],
        [NaN, 0, 1],
        [Infinity, 1, 0],
      ])
        await assert.rejects(
          repository.storeVector(owner, memory.id, memory.version, space.id, vector),
          { status: 400 },
        );
      assert.equal(
        (await repository.candidates(owner, [1, 0, 0], space.id, null, null, 20, 0)).length,
        0,
      );
    } finally {
      await db.query('DELETE FROM memory_operations WHERE namespace=$1', [secondNamespace]);
    }
  },
);
