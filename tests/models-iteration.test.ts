import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app';
import { mockProvider, imageData } from './mock-provider';
import type { Model, Message } from '../src/shared/types';
const config = (dataDir: string) => ({
  dataDir,
  secret: 'models-fixture-secret-at-least-32-characters',
  port: 0,
  host: '127.0.0.1',
  secureCookies: false,
  trustProxy: 0,
});

test('model order and platform links migrate once and survive restart without resetting provider configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drift-model-migration-'));
  const db = new DatabaseSync(join(dir, 'kakam.sqlite'));
  db.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, encrypted_key TEXT NOT NULL, api_mode TEXT NOT NULL DEFAULT 'chat-completions');
    CREATE TABLE models (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id), name TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, vision INTEGER NOT NULL DEFAULT 0, UNIQUE(provider_id,name));
    INSERT INTO providers VALUES ('p','Provider','https://example.test/v1','preserve-encrypted-key','responses');
    INSERT INTO models VALUES ('b','p','b','Beta',1,0),('a','p','a','Alpha',1,1);
  `);
  db.close();
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(config(dir));
    const current = app.kernel.ctx.db;
    assert.deepEqual(
      current.all<{ id: string }>('SELECT id FROM models ORDER BY sort_order').map((m) => m.id),
      ['a', 'b'],
    );
    assert.equal(
      current.get<{ platform_url: string | null }>('SELECT platform_url FROM providers')!
        .platform_url,
      null,
    );
    current.run("UPDATE providers SET platform_url='https://console.example.test'");
    current.run("UPDATE models SET sort_order=CASE id WHEN 'a' THEN 1 ELSE 0 END");
    await app.kernel.stop();
    app = await createApp(config(dir));
    assert.deepEqual(
      app.kernel.ctx.db
        .all<{ id: string }>('SELECT id FROM models ORDER BY sort_order')
        .map((m) => m.id),
      ['b', 'a'],
    );
    const provider = app.kernel.ctx.db.get<{
      encrypted_key: string;
      platform_url: string;
      api_mode: string;
    }>('SELECT encrypted_key,platform_url,api_mode FROM providers')!;
    assert.equal(provider.encrypted_key, 'preserve-encrypted-key');
    assert.equal(provider.platform_url, 'https://console.example.test');
    assert.equal(provider.api_mode, 'responses');
  } finally {
    await app?.kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('admin-only ordering, default fallback, platform URLs and Anthropic chat use the same permission and usage boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drift-model-api-'));
  const mock = await mockProvider();
  const app = await createApp(config(dir));
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const req = (path: string, cookie: string, method = 'GET', data?: unknown) =>
    fetch(base + path, {
      method,
      headers: { cookie, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const json = async (path: string, cookie: string, method = 'GET', data?: unknown) => {
    const res = await req(path, cookie, method, data);
    assert.ok(res.ok, `${path}: ${res.status} ${res.ok ? '' : await res.text()}`);
    return res.json();
  };
  try {
    const adminRes = await req('/auth/register', '', 'POST', {
      email: 'admin@example.test',
      displayName: 'Admin',
      password: 'x',
    });
    const admin = adminRes.headers.get('set-cookie')!.split(';')[0];
    const readerRes = await req('/auth/register', '', 'POST', {
      email: 'reader@example.test',
      displayName: 'Reader',
      password: 'x',
    });
    const reader = readerRes.headers.get('set-cookie')!.split(';')[0];
    const userId = (await readerRes.json()).user.id;
    const settings = {
      name: 'Claude',
      baseUrl: mock.url,
      apiKey: 'fixture-secret',
      apiMode: 'anthropic-messages',
      platformUrl: 'https://console.example.test/settings',
    };
    const provider = await json('/admin/providers', admin, 'POST', settings);
    const providers = await json('/admin/providers', admin);
    assert.equal(providers[0].platformUrl, settings.platformUrl);
    assert.ok(!JSON.stringify(providers).includes('fixture-secret'));
    assert.equal((await req('/admin/providers', reader)).status, 403);
    for (const platformUrl of [
      'javascript:alert(1)',
      'https://name:pass@example.test',
      'not-a-url',
    ])
      assert.equal(
        (await req('/admin/providers', admin, 'POST', { ...settings, platformUrl })).status,
        400,
      );
    await json(`/admin/providers/${provider.id}`, admin, 'PATCH', {
      name: 'Claude',
      baseUrl: mock.url,
      apiMode: 'anthropic-messages',
    });
    assert.equal((await json('/admin/providers', admin))[0].platformUrl, settings.platformUrl);
    await json(`/admin/providers/${provider.id}`, admin, 'PATCH', {
      ...settings,
      apiKey: undefined,
      platformUrl: '',
    });
    assert.equal((await json('/admin/providers', admin))[0].platformUrl, null);
    assert.deepEqual(
      (await json(`/admin/providers/${provider.id}/discover`, admin, 'POST', {})).models,
      ['test-vision', 'test-text'],
    );
    const ids: string[] = [];
    for (const name of ['test-vision', 'test-text', 'disabled'])
      ids.push(
        (
          await json('/admin/models', admin, 'POST', {
            name,
            label: name,
            providerId: provider.id,
            vision: name === 'test-vision',
          })
        ).id,
      );
    const order = [ids[2], ids[1], ids[0]];
    for (const cookie of ['', reader])
      assert.equal(
        (await req('/admin/models/order', cookie, 'PATCH', { modelIds: order })).status,
        cookie ? 403 : 401,
      );
    assert.equal(
      (await req('/admin/models/order', admin, 'PATCH', { modelIds: [ids[0], ids[0], ids[2]] }))
        .status,
      400,
    );
    for (const modelIds of [ids.slice(0, 2), [...ids, randomUUID()]])
      assert.equal((await req('/admin/models/order', admin, 'PATCH', { modelIds })).status, 409);
    await json(`/admin/models/${ids[2]}`, admin, 'PATCH', {
      label: 'Disabled',
      vision: false,
      enabled: false,
      userIds: [userId],
    });
    await json(`/admin/models/${ids[0]}`, admin, 'PATCH', {
      label: 'Vision',
      vision: true,
      enabled: true,
      userIds: [userId],
    });
    await json('/admin/models/order', admin, 'PATCH', { modelIds: order });
    assert.deepEqual(
      (await json('/admin/models', admin)).map((m: Model) => m.id),
      order,
    );
    assert.deepEqual(
      (await json('/models', admin)).map((m: Model) => m.id),
      [ids[1], ids[0]],
    );
    assert.deepEqual(
      (await json('/models', reader)).map((m: Model) => m.id),
      [ids[0]],
    );
    const appended = await json('/admin/models', admin, 'POST', {
      name: 'new',
      label: 'Alphabetically first',
      providerId: provider.id,
    });
    assert.equal((await json('/admin/models', admin)).at(-1).id, appended.id);
    const probe = await json(`/admin/models/${ids[0]}/test`, admin, 'POST', {});
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.usage, { input: 23, output: 42, total: 65 });
    assert.equal(mock.anthropicHeaders.at(-1)?.['x-api-key'], 'fixture-secret');
    const failedProbe = await json(`/admin/models/${appended.id}/test`, admin, 'POST', {});
    assert.equal(failedProbe.ok, true);
    const failedModel = await json('/admin/models', admin, 'POST', {
      name: 'upstream-error',
      label: 'Unreachable',
      providerId: provider.id,
    });
    const failed = await json(`/admin/models/${failedModel.id}/test`, admin, 'POST', {});
    assert.equal(failed.ok, false);
    assert.equal(failed.firstTextMs, null);
    assert.equal(failed.usage, null);
    assert.ok(!failed.error.includes('sensitive upstream details'));
    assert.equal(failed.diagnostics.response.status, 401);
    assert.match(failed.diagnostics.response.body, /sensitive upstream details/);
    assert.equal((await json('/usage', admin)).rows[0].status, 'error');
    const disabledProbe = await json(`/admin/models/${ids[2]}/test`, admin, 'POST', {});
    assert.equal(disabledProbe.ok, true);
    assert.ok(!(await json('/models', admin)).some((m: Model) => m.id === ids[2]));
    const chat = await json('/conversations', reader, 'POST', {});
    await json(`/conversations/${chat.id}/messages`, reader, 'POST', {
      modelId: ids[0],
      content: '图片',
      images: [{ name: 'pixel.png', data: imageData }],
    });
    const stream = await (await req(`/conversations/${chat.id}/events`, reader)).text();
    assert.ok(stream.includes('delta'));
    assert.ok(stream.includes('"usage":{"input":23,"output":42,"total":65}'));
    const messages: Message[] = (await json(`/conversations/${chat.id}`, reader)).messages;
    assert.deepEqual(messages[1].usage, { input: 23, output: 42, total: 65 });
    assert.equal((await req(`/conversations/${chat.id}`, admin)).status, 404);
    assert.equal((await json('/usage', reader)).totals.total, 65);
    // Reloaded historical messages without usage must not appear as zero-token calls.
    app.kernel.ctx.db.run('DELETE FROM usage WHERE id=?', messages[1].id);
    assert.equal((await json(`/conversations/${chat.id}`, reader)).messages[1].usage, null);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await app.kernel.stop();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
