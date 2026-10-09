import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app';
import { KHKernel } from '../src/kernel';
import { HttpError } from '../src/kernel/http';
import {
  productionLimits,
  type ProductionList,
  type ProductionSpace,
} from '../src/features/llm-production/types';
import type { User } from '../src/shared/types';

let app: Awaited<ReturnType<typeof createApp>>;
let server: ReturnType<typeof createServer>;
let directory: string;
let url: string;
let admin: { cookie: string; user: User };
let member: { cookie: string; user: User };
let other: { cookie: string; user: User };
const day = 86_400_000;
const config = {
  secret: 'llm-production-private-test-secret-at-least-32-characters',
  port: 0,
  host: '127.0.0.1',
  secureCookies: false,
  trustProxy: 0,
};

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = member?.cookie ?? '',
) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}
async function json<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie?: string,
): Promise<T> {
  const response = await request(path, method, body, cookie);
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
  return data as T;
}
async function register(name: string) {
  const response = await request(
    '/auth/register',
    'POST',
    {
      email: `${name}@example.test`,
      displayName: name,
      password: 'x',
    },
    '',
  );
  assert.equal(response.status, 201);
  return {
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    user: (await response.json()).user as User,
  };
}
async function conversation(groupId?: string) {
  return (await json('/conversations', 'POST', { groupId })).id as string;
}
function assistant(conversationId: string) {
  const id = randomUUID();
  app.kernel.ctx.db.run(
    "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'assistant','已生成',?)",
    id,
    conversationId,
    new Date().toISOString(),
  );
  return id;
}
function create(
  conversationId: string,
  options: { name?: string; messageId?: string; idempotencyKey?: string; data?: Uint8Array } = {},
) {
  return app.kernel.ctx.production.create(member.user, {
    conversationId,
    name: '示例.txt',
    mimeType: 'text/plain',
    data: Buffer.from('你好\nDrift Space'),
    ...options,
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-production-'));
  app = await createApp({ ...config, dataDir: directory });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await register('production-admin');
  member = await register('production-user');
  other = await register('production-other');
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  await app?.kernel.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('production is a protected core feature with private preferences and scoped file downloads', async () => {
  const features = await json('/features');
  assert.equal(
    features.find((feature: { id: string }) => feature.id === 'llm-production').kind,
    'core',
  );
  assert.equal(
    (await request('/features/llm-production', 'PATCH', { enabled: false }, admin.cookie)).status,
    400,
  );
  assert.equal((await request('/llm-production/spaces', 'GET', undefined, '')).status, 401);
  assert.deepEqual(await json('/llm-production/preferences'), {
    enabled: true,
    temporaryRetentionDays: 7,
    imageModelId: null,
  });
  const id = await conversation();
  const messageId = assistant(id);
  const file = create(id, { name: '你好 report.txt', messageId, idempotencyKey: 'private-file' });
  assert.equal(Date.parse(file.expiresAt!) - Date.parse(file.createdAt), 7 * day);
  const response = await request(`/llm-production/artifacts/${file.id}/download`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '你好\nDrift Space');
  assert.ok(response.headers.get('content-disposition')!.startsWith('attachment;'));
  assert.ok(response.headers.get('content-disposition')!.includes("filename*=UTF-8''"));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  for (const cookie of [admin.cookie, other.cookie]) {
    assert.equal(
      (await request(`/llm-production/artifacts/${file.id}/download`, 'GET', undefined, cookie))
        .status,
      404,
    );
    assert.equal(
      (await request(`/llm-production/artifacts/${file.id}`, 'DELETE', undefined, cookie)).status,
      404,
    );
    assert.equal(
      (await request(`/llm-production/artifacts?conversationId=${id}`, 'GET', undefined, cookie))
        .status,
      404,
    );
  }
  assert.deepEqual(
    (await json<ProductionList>(`/llm-production/artifacts?conversationId=${id}`)).artifacts.map(
      ({ id }) => id,
    ),
    [file.id],
  );
  assert.deepEqual(app.kernel.ctx.production.forMessage(member.user.id, messageId), [file]);
  assert.deepEqual(app.kernel.ctx.production.forMessage(admin.user.id, messageId), []);
  assert.equal(app.kernel.ctx.production.findCreated(member.user.id, 'private-file')!.id, file.id);
  assert.equal(app.kernel.ctx.production.findCreated(other.user.id, 'private-file'), undefined);
  assert.equal(
    create(id, { name: file.name, messageId, idempotencyKey: 'private-file' }).id,
    file.id,
  );
  assert.throws(
    () => create(id, { name: 'different.txt', messageId, idempotencyKey: 'private-file' }),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  await json(`/llm-production/artifacts/${file.id}`, 'DELETE');
  assert.equal((await request(`/llm-production/artifacts/${file.id}/download`)).status, 404);
  assert.deepEqual(app.kernel.ctx.production.forMessage(member.user.id, messageId), []);
});

test('group spaces share files, adopt standalone files and retain files through source chat moves/deletion', async () => {
  const group = await json('/conversation-groups', 'POST', { name: '共享文件' });
  const groupB = await json('/conversation-groups', 'POST', { name: '另一个分组' });
  const a = await conversation(group.id);
  const b = await conversation(group.id);
  const file = create(a);
  assert.equal(file.expiresAt, null);
  assert.equal(file.groupId, group.id);
  assert.equal(
    (await json<ProductionList>(`/llm-production/artifacts?conversationId=${b}`)).artifacts[0].id,
    file.id,
  );
  const solo = await conversation();
  const adopted = create(solo);
  await json(`/conversations/${solo}`, 'PATCH', { groupId: group.id });
  assert.equal(app.kernel.ctx.production.get(member.user.id, adopted.id).expiresAt, null);
  assert.equal(app.kernel.ctx.production.get(member.user.id, adopted.id).groupId, group.id);
  await json(`/conversations/${a}`, 'PATCH', { groupId: groupB.id });
  assert.equal(app.kernel.ctx.production.get(member.user.id, file.id).groupId, group.id);
  assert.deepEqual(
    (await json<ProductionList>(`/llm-production/artifacts?conversationId=${a}`)).artifacts,
    [],
  );
  await json(`/conversations/${solo}`, 'DELETE');
  assert.equal(app.kernel.ctx.production.get(member.user.id, adopted.id).conversationId, null);
  assert.equal(app.kernel.ctx.production.get(member.user.id, adopted.id).expiresAt, null);
  await json(`/conversation-groups/${group.id}`, 'DELETE');
  assert.equal(app.kernel.ctx.production.get(member.user.id, file.id).groupId, groupB.id);
  assert.equal(app.kernel.ctx.production.get(member.user.id, file.id).expiresAt, null);
  const orphan = app.kernel.ctx.production.get(member.user.id, adopted.id);
  assert.equal(orphan.groupId, null);
  assert.ok(Date.parse(orphan.expiresAt!) > Date.now() + 6 * day);
  assert.ok(
    (await json<ProductionSpace[]>('/llm-production/spaces')).some(
      (space) => space.kind === 'orphan' && space.artifactCount === 1,
    ),
  );
  const standalone = await conversation();
  const removed = create(standalone);
  await json(`/conversations/${standalone}`, 'DELETE');
  assert.throws(
    () => app.kernel.ctx.production.get(member.user.id, removed.id),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
});

test('3–7 day retention recalculates fixed creation age and expired files cannot be downloaded or resurrected', async () => {
  const id = await conversation();
  const messageId = assistant(id);
  const file = create(id, { messageId });
  const createdAt = new Date(Date.now() - 4 * day).toISOString();
  app.kernel.ctx.db.run(
    'UPDATE production_artifacts SET created_at=?,temporary_started_at=?,expires_at=? WHERE id=?',
    createdAt,
    createdAt,
    new Date(Date.now() + 3 * day).toISOString(),
    file.id,
  );
  assert.equal(
    (await request('/llm-production/preferences', 'PATCH', { temporaryRetentionDays: 2 })).status,
    400,
  );
  assert.equal(
    (await request('/llm-production/preferences', 'PATCH', { temporaryRetentionDays: 8 })).status,
    400,
  );
  await json('/llm-production/preferences', 'PATCH', { temporaryRetentionDays: 3 });
  assert.equal((await request(`/llm-production/artifacts/${file.id}/download`)).status, 404);
  assert.deepEqual(app.kernel.ctx.production.forMessage(member.user.id, messageId), []);
  await json('/llm-production/preferences', 'PATCH', { temporaryRetentionDays: 7 });
  assert.equal(app.kernel.ctx.production.findCreated(member.user.id, 'expired'), undefined);
  assert.equal((await request(`/llm-production/artifacts/${file.id}/download`)).status, 404);
  assert.equal(
    (await json('/llm-production/preferences', 'GET', undefined, other.cookie))
      .temporaryRetentionDays,
    7,
  );
  const stale = create(id, { messageId, idempotencyKey: 'expired' });
  app.kernel.ctx.db.run(
    'UPDATE production_artifacts SET expires_at=? WHERE id=?',
    new Date(Date.now() - 1).toISOString(),
    stale.id,
  );
  assert.equal((await request(`/llm-production/artifacts/${stale.id}/download`)).status, 404);
  assert.equal(app.kernel.ctx.production.findCreated(member.user.id, 'expired'), undefined);
  await json('/llm-production/preferences', 'PATCH', { temporaryRetentionDays: 7 });
  assert.equal(
    app.kernel.ctx.db.get('SELECT id FROM production_artifacts WHERE id=?', stale.id),
    undefined,
  );
  const group = await json('/conversation-groups', 'POST', { name: '保留' });
  const grouped = create(await conversation(group.id));
  const future = Date.now() + 40 * day;
  assert.ok(app.kernel.ctx.production.cleanup(future) >= 1);
  assert.equal(app.kernel.ctx.production.get(member.user.id, grouped.id).expiresAt, null);
});

test('generation validates file boundaries, message ownership and user generation settings', async () => {
  const id = await conversation();
  for (const name of ['../outside.txt', 'folder/file.txt', 'bad\nheader.txt', '.'])
    assert.throws(() => create(id, { name }));
  assert.throws(
    () => create(id, { data: new Uint8Array(productionLimits.fileBytes + 1) }),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  assert.throws(
    () => create(id, { messageId: randomUUID() }),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  const foreign = (await json('/conversations', 'POST', {}, other.cookie)).id;
  assert.throws(
    () => create(id, { messageId: assistant(foreign) }),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  assert.throws(
    () => create(foreign),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  const abort = new AbortController();
  abort.abort();
  assert.throws(() =>
    app.kernel.ctx.production.create(
      member.user,
      { conversationId: id, name: 'cancelled.txt', mimeType: 'text/plain', data: new Uint8Array() },
      abort.signal,
    ),
  );
  await json('/llm-production/preferences', 'PATCH', { enabled: false });
  assert.throws(
    () => create(id),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  assert.equal(
    (await json('/llm-production/settings')).storage.limitBytes,
    productionLimits.accountBytes,
  );
  assert.equal(
    (await json('/llm-production/preferences', 'GET', undefined, other.cookie)).enabled,
    true,
  );
  await json('/llm-production/preferences', 'PATCH', { enabled: true });
});

test('administrator capacity defaults to 1 GiB, validates access and immediately enforces per-account quotas', async () => {
  const path = '/admin/llm-production/settings';
  assert.equal((await request(path, 'GET', undefined, '')).status, 401);
  for (const cookie of [member.cookie, other.cookie]) {
    assert.equal((await request(path, 'GET', undefined, cookie)).status, 403);
    assert.equal((await request(path, 'PATCH', { accountLimitMiB: 2048 }, cookie)).status, 403);
  }
  assert.throws(
    () => app.kernel.ctx.production.saveAdminSettings(member.user, { accountLimitMiB: 2048 }),
    (error: unknown) => error instanceof HttpError && error.status === 403,
  );
  const original = await json(path, 'GET', undefined, admin.cookie);
  assert.deepEqual(original, { accountLimitMiB: 1024 });
  assert.equal((await json('/llm-production/settings')).storage.limitBytes, 1024 ** 3);
  for (const invalid of [0, -1, 19, 20.5, '1024', null, productionLimits.maxAccountMiB + 1]) {
    assert.equal(
      (await request(path, 'PATCH', { accountLimitMiB: invalid }, admin.cookie)).status,
      400,
    );
  }
  assert.equal((await request(path, 'PATCH', {}, admin.cookie)).status, 400);
  assert.equal(
    (await request(path, 'PATCH', { accountLimitMiB: 1024, userId: member.user.id }, admin.cookie))
      .status,
    400,
  );
  const conversationId = await conversation();
  const foreignConversation = (await json('/conversations', 'POST', {}, other.cookie)).id;
  try {
    await json(path, 'PATCH', { accountLimitMiB: 20 }, admin.cookie);
    const seed = create(conversationId, {
      name: 'quota-seed.txt',
      idempotencyKey: 'quota-seed',
      data: Buffer.from('seed'),
    });
    // Only the temporary fixture's metadata simulates a nearly full account; no GiB allocation.
    const used = app.kernel.ctx.production.storage(member.user.id).usedBytes;
    app.kernel.ctx.db.run(
      'UPDATE production_artifacts SET size=? WHERE id=?',
      20 * 1024 * 1024 - (used - seed.size) - 1,
      seed.id,
    );
    assert.throws(
      () => create(conversationId, { data: Buffer.from('xx') }),
      (error: unknown) => error instanceof HttpError && /20 MiB/.test(error.message),
    );
    create(conversationId, { name: 'last-byte.txt', data: Buffer.from('x') });
    assert.equal(app.kernel.ctx.production.storage(member.user.id).usedBytes, 20 * 1024 * 1024);
    assert.equal(
      create(conversationId, {
        name: 'quota-seed.txt',
        idempotencyKey: 'quota-seed',
        data: Buffer.from('seed'),
      }).id,
      seed.id,
    );
    assert.throws(
      () => create(conversationId),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    await json(path, 'PATCH', { accountLimitMiB: 2048 }, admin.cookie);
    assert.equal((await json('/llm-production/settings')).storage.limitBytes, 2 * 1024 ** 3);
    create(conversationId, { name: 'after-raise.txt', data: Buffer.from('xx') });
    await json(path, 'PATCH', { accountLimitMiB: 20 }, admin.cookie);
    assert.equal(
      await (await request(`/llm-production/artifacts/${seed.id}/download`)).text(),
      'seed',
    );
    assert.ok(
      (
        await json<ProductionList>(`/llm-production/artifacts?conversationId=${conversationId}`)
      ).artifacts.some((item) => item.id === seed.id),
    );
    assert.throws(
      () => create(conversationId),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    const foreign = app.kernel.ctx.production.create(other.user, {
      conversationId: foreignConversation,
      name: 'other.txt',
      mimeType: 'text/plain',
      data: Buffer.from('other'),
    });
    assert.ok(foreign.id);
  } finally {
    await json('/conversations/' + conversationId, 'DELETE');
    await json('/conversations/' + foreignConversation, 'DELETE', undefined, other.cookie);
    await json(path, 'PATCH', original, admin.cookie);
  }
});

test('restart preserves file bytes and removes expired temporary files before requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-production-restart-'));
  let instance: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    instance = await createApp({ ...config, dataDir: dir });
    const db = instance.kernel.ctx.db;
    const user = { ...member.user, id: randomUUID() };
    const conversationId = randomUUID();
    const groupId = randomUUID();
    const groupedId = randomUUID();
    db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'unused','user')",
      user.id,
      user.id,
      'Restart fixture',
    );
    db.run(
      "INSERT INTO conversation_groups(id,user_id,name,created_at) VALUES(?,?,'保留',?)",
      groupId,
      user.id,
      new Date().toISOString(),
    );
    db.run(
      "INSERT INTO conversations(id,user_id,title,updated_at) VALUES(?,?,'临时',?)",
      conversationId,
      user.id,
      new Date().toISOString(),
    );
    db.run(
      "INSERT INTO conversations(id,user_id,title,updated_at,group_id) VALUES(?,?,'分组',?,?)",
      groupedId,
      user.id,
      new Date().toISOString(),
      groupId,
    );
    const input = {
      conversationId,
      name: 'persisted.txt',
      mimeType: 'text/plain',
      data: Buffer.from('持久文件内容'),
    };
    const expired = instance.kernel.ctx.production.create(user, input);
    const persistent = instance.kernel.ctx.production.create(user, {
      ...input,
      conversationId: groupedId,
    });
    db.run(
      'UPDATE production_artifacts SET expires_at=? WHERE id=?',
      new Date(Date.now() - 1).toISOString(),
      expired.id,
    );
    instance.kernel.ctx.production.saveAdminSettings(
      { ...user, role: 'admin' },
      { accountLimitMiB: 3072 },
    );
    await instance.kernel.stop();
    instance = await createApp({ ...config, dataDir: dir });
    assert.deepEqual(instance.kernel.ctx.production.adminSettings(), { accountLimitMiB: 3072 });
    assert.equal(instance.kernel.ctx.production.storage(user.id).limitBytes, 3 * 1024 ** 3);
    assert.equal(
      instance.kernel.ctx.db.get('SELECT id FROM production_artifacts WHERE id=?', expired.id),
      undefined,
    );
    assert.equal(
      Buffer.from(instance.kernel.ctx.production.download(user.id, persistent.id).data).toString(),
      '持久文件内容',
    );
    assert.equal(instance.kernel.ctx.production.get(user.id, persistent.id).expiresAt, null);
  } finally {
    await instance?.kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('image-kind migration preserves old models, grants, selected preferences and indexes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-production-migration-'));
  let kernel: KHKernel | undefined;
  try {
    const old = new DatabaseSync(join(dir, 'kakam.sqlite'));
    old.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,base_url TEXT NOT NULL,encrypted_key TEXT NOT NULL);
      CREATE TABLE models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,name TEXT NOT NULL,label TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,vision INTEGER NOT NULL DEFAULT 0,kind TEXT NOT NULL DEFAULT 'llm' CHECK(kind IN ('llm','jev','embedding')),UNIQUE(provider_id,name));
      CREATE TABLE model_grants(model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(model_id,user_id));
      CREATE TABLE prompt_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,summary_model_id TEXT REFERENCES models(id) ON DELETE SET NULL);
      CREATE INDEX idx_legacy_model_label ON models(label);
      INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','unused','admin');
      INSERT INTO providers VALUES('source','Source','http://127.0.0.1:1','unused');
      INSERT INTO models(id,provider_id,name,label) VALUES('model','source','old-model','Old model');
      INSERT INTO model_grants VALUES('model','owner');
      INSERT INTO prompt_preferences VALUES('owner','model');`);
    old.close();
    kernel = new KHKernel(dir);
    await kernel.ctx.start();
    const db = kernel.ctx.db;
    assert.equal(
      db.get<{ name: string }>('SELECT name FROM models WHERE id=?', 'model')!.name,
      'old-model',
    );
    assert.equal(
      db.get<{ summary_model_id: string }>(
        'SELECT summary_model_id FROM prompt_preferences WHERE user_id=?',
        'owner',
      )!.summary_model_id,
      'model',
    );
    assert.equal(db.all('SELECT * FROM model_grants').length, 1);
    assert.ok(
      db.get("SELECT name FROM sqlite_schema WHERE type='index' AND name='idx_legacy_model_label'"),
    );
    db.run(
      "INSERT INTO models(id,provider_id,name,label,kind) VALUES('image','source','image-model','Image','image')",
    );
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    db.run("DELETE FROM models WHERE id='model'");
    assert.equal(db.all('SELECT * FROM model_grants').length, 0);
    assert.equal(
      db.get<{ summary_model_id: null }>(
        "SELECT summary_model_id FROM prompt_preferences WHERE user_id='owner'",
      )!.summary_model_id,
      null,
    );
    await kernel.stop();
    kernel = new KHKernel(dir);
    await kernel.ctx.start();
    assert.equal(
      kernel.ctx.db.get<{ kind: string }>("SELECT kind FROM models WHERE id='image'")!.kind,
      'image',
    );
  } finally {
    await kernel?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
