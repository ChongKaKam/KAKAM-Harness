import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveGatewayKey } from '../src/features/openai-gateway/keys';
import { KHKernel } from '../src/kernel';
import { digest, SecretVault } from '../src/kernel/crypto';
import { createApp } from '../src/server/app';

test('legacy devices keep their original official credentials through source deletion, rotation and restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kh-gateway-upgrade-'));
  const config = {
    dataDir,
    secret: 'gateway-migration-fixture-secret-at-least-32',
    host: '127.0.0.1',
    port: 0,
    secureCookies: false,
    trustProxy: 0,
  };
  const vault = new SecretVault(config.secret);
  const localFetch = globalThis.fetch;
  // Model-source probes at startup are local fixtures too.
  globalThis.fetch = async () => Response.json({ object: 'list', data: [] });
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  t.after(async () => {
    await app?.kernel.stop();
    globalThis.fetch = localFetch;
    await rm(dataDir, { recursive: true, force: true });
  });

  const legacy = new KHKernel(dataDir);
  const owner = randomUUID();
  const singleSourceOwner = randomUUID();
  const unavailableSourceOwner = randomUUID();
  const devices = [
    { name: 'laptop', user: owner, source: 'first' },
    { name: 'desktop', user: owner, source: 'second' },
    { name: 'changed-source', user: unavailableSourceOwner, source: 'unofficial' },
    { name: 'tablet', user: singleSourceOwner, source: 'second' },
  ].map((device) => ({
    ...device,
    id: randomUUID(),
    key: 'dsk_' + randomBytes(32).toString('base64url'),
  }));
  const [laptop, desktop, unavailable, tablet] = devices;
  try {
    const { db } = legacy.ctx;
    db.connection.exec(`
      DROP TABLE openai_gateway_keys;
      DROP TABLE openai_gateway_config;
      CREATE TABLE openai_gateway_keys (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_openai_gateway_keys_user ON openai_gateway_keys(user_id,created_at);
    `);
    for (const id of [owner, singleSourceOwner, unavailableSourceOwner]) {
      db.run(
        "INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'unused','admin')",
        id,
        id,
        id,
      );
      db.run('INSERT INTO sessions VALUES(?,?,?)', digest(id), id, Date.now() + 60_000);
    }
    for (const [id, url] of [
      ['first', 'https://api.openai.com/v1/'],
      ['second', 'https://api.openai.com/v1'],
      ['unofficial', 'https://example.test/v1'],
    ]) {
      db.run(
        'INSERT INTO providers(id,name,base_url,encrypted_key) VALUES(?,?,?,?)',
        id,
        id,
        url,
        vault.encrypt('fixture-' + id),
      );
    }
    for (const { id, name, user, source, key } of devices) {
      db.run(
        'INSERT INTO openai_gateway_keys VALUES(?,?,?,?,?,?,?)',
        id,
        user,
        source,
        name,
        key.slice(0, 12),
        digest(key),
        1200,
      );
    }
  } finally {
    await legacy.stop();
  }

  app = await createApp(config);
  const resolve = (key: string) => resolveGatewayKey(app!.kernel.ctx, vault, 'Bearer ' + key);
  const refused = (key: string, status: number) => assert.throws(() => resolve(key), { status });
  // The source settings cease to be a runtime dependency after migration.
  app.kernel.ctx.db.run('DELETE FROM providers');
  const originalBindings = () => {
    assert.deepEqual(resolve(laptop.key), { userId: owner, apiKey: 'fixture-first' });
    assert.deepEqual(resolve(desktop.key), { userId: owner, apiKey: 'fixture-second' });
    assert.deepEqual(resolve(tablet.key), { userId: singleSourceOwner, apiKey: 'fixture-second' });
    refused(unavailable.key, 503);
  };
  originalBindings();
  await app.kernel.stop();
  app = await createApp(config);
  originalBindings();

  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin =
    'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/admin/openai-gateway';
  const admin = (user: string, path = '', method = 'GET', body?: object) =>
    localFetch(origin + path, {
      method,
      headers: { cookie: 'kh_session=' + user, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  let newlyIssued: string;
  try {
    const listing = await (await admin(owner)).json();
    assert.equal(listing.configured, false);
    assert.deepEqual(
      listing.keys.map((entry: { id: string }) => entry.id).sort(),
      [laptop.id, desktop.id].sort(),
    );
    assert.deepEqual(
      listing.keys.find((entry: { id: string }) => entry.id === laptop.id),
      { id: laptop.id, name: 'laptop', prefix: laptop.key.slice(0, 12), createdAt: 1200 },
    );
    assert.equal((await admin(owner, '/keys', 'POST', { name: 'premature' })).status, 400);
    assert.equal((await (await admin(singleSourceOwner)).json()).configured, true);
    assert.equal((await admin(owner, '/config', 'PUT', { apiKey: 'fixture-rotated' })).status, 200);
    for (const { key } of [laptop, desktop]) {
      assert.deepEqual(resolve(key), { userId: owner, apiKey: 'fixture-rotated' });
    }
    refused(unavailable.key, 503);
    const issued = await admin(owner, '/keys', 'POST', { name: 'new device' });
    assert.equal(issued.status, 201);
    newlyIssued = (await issued.json()).key;
    assert.equal((await admin(owner, '/keys/' + desktop.id, 'DELETE')).status, 200);
    refused(desktop.key, 401);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await app.kernel.stop();
  app = await createApp(config);
  refused(desktop.key, 401);
  for (const key of [newlyIssued, laptop.key]) {
    assert.deepEqual(resolve(key), { userId: owner, apiKey: 'fixture-rotated' });
  }
  refused(unavailable.key, 503);
  assert.deepEqual(resolve(tablet.key), { userId: singleSourceOwner, apiKey: 'fixture-second' });
});
