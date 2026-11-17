import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server/app';
import { RelayStore } from '../src/features/relay/store';
import {
  relayLifetimeMs,
  relayLimits,
  type RelayAttachment,
  type RelayCard,
} from '../src/features/relay/types';

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
function attachmentPath(cardId: string, id: string) {
  return `/relay/${cardId}/attachments/${id}`;
}
function uploadChunk(
  path: string,
  offset: number,
  body: Uint8Array<ArrayBuffer>,
  cookie = member,
  origin?: string,
) {
  return fetch(`${url}/api${path}/upload?offset=${offset}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
    },
    body,
  });
}
async function addAttachment(cardId: string, filename: string, contents: Uint8Array<ArrayBuffer>) {
  const pending = await json<{ id: string; cardId: string }>(
    `/relay/${cardId}/attachments`,
    'POST',
    {
      filename,
      sizeBytes: contents.length,
    },
  );
  assert.equal(pending.cardId, cardId);
  const response = await uploadChunk(attachmentPath(cardId, pending.id), 0, contents);
  assert.equal(response.status, 200);
  const { attachment } = (await response.json()) as { attachment: RelayAttachment };
  return attachment;
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

test('relay files become visible only after the final chunk and every file operation is scoped to its owner and card', async () => {
  const card = await json('/relay', 'POST', { content: '附件上传' });
  const otherCard = await json('/relay', 'POST', { content: '另一个卡片' });
  const filename = '资料 (备份)#1+.html';
  const first = new Uint8Array([0, 255]);
  const last = new Uint8Array([13, 10]);
  const reserve = `/relay/${card.id}/attachments`;
  const input = { filename, sizeBytes: first.length + last.length };
  for (const invalidFilename of ['../文档.html', 'bad\nname.txt']) {
    assert.equal(
      (await request(reserve, 'POST', { ...input, filename: invalidFilename })).status,
      400,
    );
  }
  for (const cookie of ['', admin]) {
    const response = await request(reserve, 'POST', input, cookie);
    assert.equal(response.status, cookie ? 404 : 401);
  }
  const pending = await json<{ id: string; cardId: string }>(reserve, 'POST', input);
  assert.equal(pending.cardId, card.id);
  const path = attachmentPath(card.id, pending.id);
  assert.equal((await request(`${path}/upload?offset=0`, 'PUT', {})).status, 415);
  assert.equal((await uploadChunk(path, 0, first, '')).status, 401);
  assert.equal((await uploadChunk(path, 0, first, admin)).status, 404);
  assert.equal((await uploadChunk(path, 0, first, member, 'https://other.example')).status, 403);
  assert.equal((await uploadChunk(path, 1, first)).status, 409);
  const partial = await uploadChunk(path, 0, first);
  assert.equal(partial.status, 200);
  assert.equal((await partial.json()).received, first.length);
  const retry = await uploadChunk(path, 0, first);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).received, first.length);
  assert.deepEqual((await json(`/relay/${card.id}`)).attachments, []);
  assert.equal((await request(`${path}/download`)).status, 404);
  assert.equal((await uploadChunk(attachmentPath(otherCard.id, pending.id), 2, last)).status, 404);

  const complete = await uploadChunk(path, 2, last);
  assert.equal(complete.status, 200);
  const result = (await complete.json()) as { received: number; attachment: RelayAttachment };
  assert.equal(result.received, input.sizeBytes);
  const repeatedFinalChunk = await uploadChunk(path, 2, last);
  assert.equal(repeatedFinalChunk.status, 200);
  assert.deepEqual(await repeatedFinalChunk.json(), result);
  const { attachment } = result;
  assert.equal(attachment.id, pending.id);
  assert.equal(attachment.filename, filename);
  assert.equal(attachment.sizeBytes, input.sizeBytes);
  assert.equal(
    Date.parse(attachment.expiresAt!) - Date.parse(attachment.createdAt),
    relayLifetimeMs,
  );
  assert.equal(attachment.persistedAt, null);
  assert.deepEqual((await json(`/relay/${card.id}`)).attachments, [attachment]);
  for (const cookie of ['', admin]) {
    const status = cookie ? 404 : 401;
    assert.equal((await request(`${path}/download`, 'GET', undefined, cookie)).status, status);
    assert.equal(
      (await request(`${path}/persist`, 'POST', { confirmed: true }, cookie)).status,
      status,
    );
    assert.equal((await request(path, 'DELETE', undefined, cookie)).status, status);
  }
  assert.equal(
    (await request(`${attachmentPath(otherCard.id, attachment.id)}/download`)).status,
    404,
  );
  const download = await request(`${path}/download`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  const disposition = download.headers.get('content-disposition')!;
  assert.match(disposition, /^attachment\b/);
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  assert.equal(decodeURIComponent(encodedName ?? ''), filename);
  assert.deepEqual(
    new Uint8Array(await download.arrayBuffer()),
    new Uint8Array([...first, ...last]),
  );

  await json(path, 'DELETE');
  assert.equal((await request(`${path}/download`)).status, 404);
  assert.deepEqual((await json(`/relay/${card.id}`)).attachments, []);
  await json(`/relay/${card.id}`, 'DELETE');
  await json(`/relay/${otherCard.id}`, 'DELETE');
});

test('relay validates upload sizes, enforces the per-chunk limit and cancels incomplete files', async () => {
  const card = await json('/relay', 'POST', { content: '大小限制' });
  const path = `/relay/${card.id}/attachments`;
  assert.equal(relayLimits.attachmentBytes, 300 * 1024 * 1024);
  assert.equal(
    (
      await request(path, 'POST', {
        filename: 'too-large.bin',
        sizeBytes: relayLimits.attachmentBytes + 1,
      })
    ).status,
    400,
  );
  const pending = await json<{ id: string }>(path, 'POST', {
    filename: 'max.bin',
    sizeBytes: relayLimits.attachmentBytes,
  });
  const upload = attachmentPath(card.id, pending.id);
  assert.equal((await uploadChunk(upload, 0, new Uint8Array(8 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await uploadChunk(upload, 0, new Uint8Array([1]))).status, 200);
  await json(`${upload}/upload`, 'DELETE');
  assert.equal((await uploadChunk(upload, 1, new Uint8Array([2]))).status, 404);
  const files = await readdir(join(directory, 'relay-attachments'));
  assert.ok(!files.some((file) => file.includes(pending.id)));
  const empty = await addAttachment(card.id, 'empty.txt', new Uint8Array(0));
  assert.equal(empty.sizeBytes, 0);
  const download = await request(`${attachmentPath(card.id, empty.id)}/download`);
  assert.equal(download.status, 200);
  assert.equal((await download.arrayBuffer()).byteLength, 0);
  await json(`/relay/${card.id}`, 'DELETE');
});

test('relay text and attachments expire and persist independently, and deleting a card removes file bytes', async () => {
  const db = application.kernel.ctx.db;
  const expiredAt = new Date(0).toISOString();
  const bytes = new Uint8Array([42]);
  const card = await json('/relay', 'POST', { content: '正文将消失' });
  const kept = await addAttachment(card.id, 'keep.txt', bytes);
  const temporary = await addAttachment(card.id, 'temporary.txt', bytes);
  const keptPath = attachmentPath(card.id, kept.id);
  const temporaryPath = attachmentPath(card.id, temporary.id);
  assert.equal((await request(`${keptPath}/persist`, 'POST', { confirmed: false })).status, 400);
  const persistent = await json<RelayAttachment>(`${keptPath}/persist`, 'POST', {
    confirmed: true,
  });
  assert.equal(persistent.expiresAt, null);
  assert.ok(persistent.persistedAt);
  assert.deepEqual(await json(`${keptPath}/persist`, 'POST', { confirmed: true }), persistent);
  assert.equal((await json(`/relay/${card.id}`)).expiresAt, card.expiresAt);
  db.run('UPDATE relay_cards SET expires_at=? WHERE id=?', expiredAt, card.id);
  const shell = (await json<RelayCard[]>('/relay')).find((item) => item.id === card.id)!;
  assert.equal(shell.content, '');
  assert.equal(shell.contentExpired, true);
  assert.equal(shell.attachments.length, 2);
  assert.equal(
    (await request(`/relay/${card.id}/persist`, 'POST', { confirmed: true })).status,
    404,
  );
  assert.equal((await request(`${keptPath}/download`)).status, 200);
  assert.equal((await request(`${temporaryPath}/download`)).status, 200);

  db.run('UPDATE relay_attachments SET expires_at=? WHERE id=?', expiredAt, temporary.id);
  assert.equal(
    (await request(`${temporaryPath}/persist`, 'POST', { confirmed: true })).status,
    404,
  );
  assert.equal((await request(`${temporaryPath}/download`)).status, 404);
  assert.deepEqual((await json(`/relay/${card.id}`)).attachments, [persistent]);
  await json<RelayCard[]>('/relay');
  const files = await readdir(join(directory, 'relay-attachments'));
  assert.ok(!files.some((file) => file.includes(temporary.id)));
  assert.ok(files.some((file) => file.includes(kept.id)));
  await json(`/relay/${card.id}`, 'DELETE');
  assert.equal((await request(`${keptPath}/download`)).status, 404);
  assert.ok(
    !(await readdir(join(directory, 'relay-attachments'))).some((file) => file.includes(kept.id)),
  );

  const permanentCard = await json('/relay', 'POST', { content: '长期保存的正文' });
  const expiring = await addAttachment(permanentCard.id, 'expiring.txt', bytes);
  const permanentText = await json(`/relay/${permanentCard.id}/persist`, 'POST', {
    confirmed: true,
  });
  assert.equal(permanentText.attachments[0].expiresAt, expiring.expiresAt);
  db.run('UPDATE relay_attachments SET expires_at=? WHERE id=?', expiredAt, expiring.id);
  const remaining = await json(`/relay/${permanentCard.id}`);
  assert.equal(remaining.content, permanentCard.content);
  assert.deepEqual(remaining.attachments, []);
  await json(`/relay/${permanentCard.id}`, 'DELETE');
});

test('disable and re-enable revoke routes, preserve live cards and prune cards expired while disabled; restart preserves cards', async () => {
  const temporary = await json('/relay', 'POST', { content: '重启后仍在有效期' });
  const card = await json('/relay', 'POST', { title: '长期保留', content: '跨重启保存' });
  const payload = new Uint8Array([7, 8, 9]);
  const attachment = await addAttachment(card.id, '跨重启.bin', payload);
  const download = `${attachmentPath(card.id, attachment.id)}/download`;
  const persistent = await json(`/relay/${card.id}/persist`, 'POST', { confirmed: true });
  const expired = await json('/relay', 'POST', { content: '停用期间到期' });
  await json('/features/relay', 'PATCH', { enabled: false }, admin);
  assert.equal((await request('/relay')).status, 404);
  assert.equal((await request(download)).status, 404);
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
  const restored = await request(download);
  assert.equal(restored.status, 200);
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), payload);
  assert.deepEqual(await json(`/relay/${temporary.id}`), temporary);
  await json(`/relay/${card.id}`, 'DELETE');
  await json(`/relay/${temporary.id}`, 'DELETE');
});
