import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app';
import { RelayStore } from '../src/features/relay/store';
import { relayLifetimeMs, relayLimits, type RelayCard } from '../src/features/relay/types';

let application: Awaited<ReturnType<typeof createApp>>;
let server: ReturnType<typeof createServer>;
let directory: string;
let url: string;
let admin: string;
let member: string;
const config = {
  secret: 'relay-fixture-secret-at-least-32-characters',
  port: 0,
  host: '127.0.0.1',
  secureCookies: false,
  trustProxy: 0,
};
async function start() {
  application = await createApp({ ...config, dataDir: directory });
  server = createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function stop() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await application.kernel.stop();
}
function request(path: string, method = 'GET', body?: unknown, cookie = member) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}
async function json<T = RelayCard>(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = member,
): Promise<T> {
  const response = await request(path, method, body, cookie);
  const value = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-relay-'));
  // An existing database gains the table in place, without replacing earlier application data.
  const legacy = new DatabaseSync(join(directory, 'kakam.sqlite'));
  legacy.exec(
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('fixture:existing','preserved')",
  );
  legacy.close();
  await start();
  for (const email of ['relay-admin@example.test', 'relay-member@example.test']) {
    const response = await request(
      '/auth/register',
      'POST',
      { email, displayName: email, password: 'test' },
      '',
    );
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    if (!admin) admin = cookie;
    else member = cookie;
  }
});
after(async () => {
  await stop();
  await rm(directory, { recursive: true, force: true });
});

test('relay validates inputs and isolates every operation by authenticated owner, including administrators', async () => {
  const card = await json('/relay', 'POST', {
    title: '  私有卡片  ',
    content: '  # 标题\n\n**内容**\n ',
  });
  assert.equal(card.title, '私有卡片');
  assert.equal(card.content, '  # 标题\n\n**内容**\n ');
  for (const cookie of ['', admin]) {
    const status = cookie ? 404 : 401;
    for (const [path, method, body] of [
      [`/relay/${card.id}`, 'GET', undefined],
      [`/relay/${card.id}`, 'PATCH', { content: '越权修改' }],
      [`/relay/${card.id}/persist`, 'POST', { confirmed: true }],
      [`/relay/${card.id}`, 'DELETE', {}],
    ] as const)
      assert.equal((await request(path, method, body, cookie)).status, status);
  }
  assert.equal((await request('/relay', 'GET', undefined, '')).status, 401);
  assert.equal((await request('/relay', 'POST', { content: '匿名' }, '')).status, 401);
  assert.deepEqual(await json('/relay', 'GET', undefined, admin), []);
  for (const body of [
    { content: '   ' },
    { content: 'a'.repeat(relayLimits.content + 1) },
    { title: 'a'.repeat(relayLimits.title + 1), content: 'test' },
    { content: 'test', persistedAt: new Date().toISOString() },
    { content: 'test', expiresAt: null },
  ])
    assert.equal((await request('/relay', 'POST', body)).status, 400);
  for (const body of [
    {},
    { colorSlot: 64 },
    { content: '' },
    { persistedAt: 'now' },
    { expiresAt: null },
  ])
    assert.equal((await request(`/relay/${card.id}`, 'PATCH', body)).status, 400);
  assert.equal((await request('/relay/invalid-id')).status, 400);
  const untitled = await json('/relay', 'POST', { content: '没有标题' });
  assert.equal(untitled.title, '未命名卡片');
  await json(`/relay/${untitled.id}`, 'DELETE');
  await json(`/relay/${card.id}`, 'DELETE');
  assert.equal((await request(`/relay/${card.id}`)).status, 404);
});

test('relay uses a fixed 72-hour lifetime; editing and recoloring cannot extend it, persistence requires confirmation', async () => {
  const card = await json('/relay', 'POST', { title: '暂存', content: '# Markdown\n\n正文' });
  assert.equal(Date.parse(card.expiresAt!) - Date.parse(card.createdAt), relayLifetimeMs);
  assert.equal(card.persistedAt, null);
  const edited = await json(`/relay/${card.id}`, 'PATCH', {
    title: '修改',
    content: '更新内容',
    colorSlot: 8,
  });
  assert.equal(edited.expiresAt, card.expiresAt);
  assert.equal(edited.createdAt, card.createdAt);
  assert.equal(edited.colorSlot, 8);
  for (const body of [{}, { confirmed: false }])
    assert.equal((await request(`/relay/${card.id}/persist`, 'POST', body)).status, 400);
  const beforeConfirm = Date.now();
  const persistent = await json(`/relay/${card.id}/persist`, 'POST', { confirmed: true });
  assert.equal(persistent.expiresAt, null);
  assert.ok(Date.parse(persistent.persistedAt!) >= beforeConfirm);
  assert.ok(Date.parse(persistent.persistedAt!) <= Date.now());
  const repeated = await json(`/relay/${card.id}/persist`, 'POST', { confirmed: true });
  assert.equal(repeated.persistedAt, persistent.persistedAt);
  const changed = await json(`/relay/${card.id}`, 'PATCH', { content: '持久化后的新内容' });
  assert.equal(changed.title, edited.title);
  assert.equal(changed.expiresAt, null);
  assert.equal(changed.persistedAt, persistent.persistedAt);
  new RelayStore(application.kernel.ctx.db).prune(Date.now() + relayLifetimeMs * 100);
  assert.equal((await json(`/relay/${card.id}`)).content, changed.content);
  await json(`/relay/${card.id}`, 'DELETE');
});

test('expired cards reject reads, edits, deletes and persistence before cleanup; cleanup also works without a list request', async () => {
  const card = await json('/relay', 'POST', { content: '即将到期' });
  const expiredAt = new Date(Date.now() - 1).toISOString();
  application.kernel.ctx.db.run(
    'UPDATE relay_cards SET expires_at=? WHERE id=?',
    expiredAt,
    card.id,
  );
  for (const [path, method, body] of [
    [`/relay/${card.id}`, 'GET', undefined],
    [`/relay/${card.id}`, 'PATCH', { content: '延长' }],
    [`/relay/${card.id}/persist`, 'POST', { confirmed: true }],
    [`/relay/${card.id}`, 'DELETE', {}],
  ] as const)
    assert.equal((await request(path, method, body)).status, 404);
  const store = new RelayStore(application.kernel.ctx.db);
  store.prune(Date.parse(expiredAt) - 1);
  assert.ok(application.kernel.ctx.db.get('SELECT id FROM relay_cards WHERE id=?', card.id));
  store.prune(Date.parse(expiredAt));
  assert.equal(
    application.kernel.ctx.db.get('SELECT id FROM relay_cards WHERE id=?', card.id),
    undefined,
  );
  const another = await json('/relay', 'POST', { content: '列表清理' });
  application.kernel.ctx.db.run(
    'UPDATE relay_cards SET expires_at=? WHERE id=?',
    expiredAt,
    another.id,
  );
  assert.ok(!(await json<RelayCard[]>('/relay')).some((item) => item.id === another.id));
  assert.equal(
    application.kernel.ctx.db.get('SELECT id FROM relay_cards WHERE id=?', another.id),
    undefined,
  );
});

test('disable and re-enable revoke routes, preserve live cards and prune cards expired while disabled; restart preserves cards', async () => {
  const temporary = await json('/relay', 'POST', { content: '重启后仍在有效期' });
  const card = await json('/relay', 'POST', { title: '长期保留', content: '跨重启保存' });
  const persistent = await json(`/relay/${card.id}/persist`, 'POST', { confirmed: true });
  const expired = await json('/relay', 'POST', { content: '停用期间到期' });
  await json('/features/relay', 'PATCH', { enabled: false }, admin);
  assert.equal((await request('/relay')).status, 404);
  application.kernel.ctx.db.run(
    'UPDATE relay_cards SET expires_at=? WHERE id=?',
    new Date(0).toISOString(),
    expired.id,
  );
  await json('/features/relay', 'PATCH', { enabled: true }, admin);
  await json('/features/relay', 'PATCH', { enabled: true }, admin);
  assert.equal((await request(`/relay/${expired.id}`)).status, 404);
  assert.deepEqual(await json(`/relay/${card.id}`), persistent);
  await stop();
  await start();
  assert.equal(
    application.kernel.ctx.db.get<{ value: string }>(
      "SELECT value FROM settings WHERE key='fixture:existing'",
    )!.value,
    'preserved',
  );
  assert.deepEqual(await json(`/relay/${card.id}`), persistent);
  assert.deepEqual(await json(`/relay/${temporary.id}`), temporary);
  await json(`/relay/${card.id}`, 'DELETE');
  await json(`/relay/${temporary.id}`, 'DELETE');
});
