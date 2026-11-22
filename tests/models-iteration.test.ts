import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app';
import { mockProvider, imageData } from './mock-provider';
import type { Model, Message, User } from '../src/shared/types';
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
    const sqlDefault = current
      .all<{ name: string; dflt_value: string }>('PRAGMA table_info(providers)')
      .find((column) => column.name === 'api_mode');
    assert.equal(sqlDefault?.dflt_value, "'responses'");
    assert.deepEqual(
      current.all<{ id: string }>('SELECT id FROM models ORDER BY sort_order').map((m) => m.id),
      ['a', 'b'],
    );
    assert.equal(
      current.get<{ platform_url: string | null }>('SELECT platform_url FROM providers')!
        .platform_url,
      null,
    );
    const limitsSql = 'SELECT context_window_tokens,max_output_tokens FROM models WHERE id=?';
    assert.deepEqual(
      { ...current.get<Record<string, number | null>>(limitsSql, 'a') },
      {
        context_window_tokens: null,
        max_output_tokens: null,
      },
    );
    current.run(
      'UPDATE models SET context_window_tokens=?,max_output_tokens=? WHERE id=?',
      1_000_000,
      8192,
      'a',
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
    assert.deepEqual(
      { ...app.kernel.ctx.db.get<Record<string, number | null>>(limitsSql, 'a') },
      {
        context_window_tokens: 1_000_000,
        max_output_tokens: 8192,
      },
    );
  } finally {
    await app?.kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('admin-only ordering, default fallback, platform URLs and Anthropic chat use the same permission and usage boundaries', async (t) => {
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
    const retired = { ...settings, apiMode: 'chat-completions' };
    for (const [path, method] of [
      ['/admin/providers', 'POST'],
      [`/admin/providers/${provider.id}`, 'PATCH'],
      ['/admin/providers/discover', 'POST'],
    ])
      assert.equal((await req(path, admin, method, retired)).status, 400);
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
    });
    assert.equal((await json('/admin/providers', admin))[0].platformUrl, settings.platformUrl);
    assert.equal((await json('/admin/providers', admin))[0].apiMode, 'anthropic-messages');
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
    await t.test(
      'saved tool probe verifies a two-call round trip and bills each attempted call independently',
      async () => {
        const tools = { mode: 'tools' };
        const disabledToolPath = `/admin/models/${ids[0]}/test`;
        const before = mock.requests.length;
        assert.equal((await req(disabledToolPath, reader, 'POST', tools)).status, 403);
        assert.equal((await req(disabledToolPath, admin, 'POST', tools)).status, 400);
        assert.equal(mock.requests.length, before);
        const source = await json('/admin/providers', admin, 'POST', {
          ...settings,
          name: 'Tool probe',
          apiMode: undefined,
        });
        for (const [name, ok, tokens] of [
          ['probe-success', true, [10, 20]],
          ['probe-no-usage', true, [10, null]],
          ['probe-wrong-tool', false, [10]],
          ['probe-wrong-answer', false, [10, 20]],
          ['probe-disconnect', false, [null]],
        ] as const) {
          const model = await json('/admin/models', admin, 'POST', {
            providerId: source.id,
            name,
            label: name,
            toolCalling: true,
          });
          const start = mock.requests.length;
          const tested = await json(`/admin/models/${model.id}/test`, admin, 'POST', tools);
          const requests = mock.requests.slice(start) as {
            tool_choice?: string;
            tools: { name: string }[];
          }[];
          assert.equal(requests.length, tokens.length);
          assert.equal(requests[0].tool_choice, undefined);
          assert.deepEqual(
            requests[0].tools.map((tool) => tool.name),
            ['read_probe'],
          );
          assert.equal(requests[1]?.tool_choice, undefined);
          assert.equal(tested.ok, ok);
          assert.deepEqual(
            tested.toolRounds.map(
              (round: { usage: { total: number } | null }) => round.usage?.total ?? null,
            ),
            tokens,
          );
          assert.equal(
            tested.usage?.total ?? null,
            tokens.some((n) => n === null)
              ? null
              : Array.from<number | null>(tokens).reduce<number>((sum, n) => sum + (n ?? 0), 0),
          );
          assert.ok(!JSON.stringify(tested).includes('fixture-secret'));
          const rows = app.kernel.ctx.db.all<{ status: string; tokens: number | null }>(
            'SELECT status,total_tokens AS tokens FROM usage WHERE model_name LIKE ? ORDER BY model_name',
            `[工具测试%] ${name}`,
          );
          assert.deepEqual(
            rows.map((r) => r.tokens),
            tokens,
          );
          assert.deepEqual(
            rows.map((r) => r.status),
            tested.toolRounds.map((r: { ok: boolean }) => (r.ok ? 'complete' : 'error')),
          );
          assert.equal(rows.at(-1)?.status, ok ? 'complete' : 'error');
        }
        const tiny = await json('/admin/models', admin, 'POST', {
          providerId: source.id,
          name: 'tiny-probe',
          label: 'Tiny',
          toolCalling: true,
          contextWindowTokens: 10,
          maxOutputTokens: 1,
        });
        const baseline = mock.requests.length;
        const blocked = await json(`/admin/models/${tiny.id}/test`, admin, 'POST', tools);
        assert.equal(blocked.ok, false);
        assert.equal(blocked.usage, null);
        assert.deepEqual(blocked.toolRounds, []);
        assert.equal(mock.requests.length, baseline);
        assert.equal(
          app.kernel.ctx.db.get("SELECT id FROM usage WHERE model_name LIKE '%tiny-probe'"),
          undefined,
        );
      },
    );
    await t.test(
      'per-model token limits preserve omitted settings, allow clearing and apply only to LLMs',
      async () => {
        const source = { ...settings, name: 'Limits', apiMode: 'responses' };
        const { id: providerId } = await json('/admin/providers', admin, 'POST', source);
        const model = { label: 'LLM', name: 'alias', providerId };
        const { id } = await json('/admin/models', admin, 'POST', {
          ...model,
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 8192,
        });
        const edit = { label: model.label, enabled: true, vision: false, userIds: [userId] };
        const path = `/admin/models/${id}`;
        const saved = async (cookie: string = admin) => {
          const models: Model[] = await json(
            cookie === admin ? '/admin/models' : '/models',
            cookie,
          );
          const { contextWindowTokens, maxOutputTokens } = models.find((m) => m.id === id)!;
          return [contextWindowTokens, maxOutputTokens];
        };
        assert.deepEqual(await saved(), [1_000_000, 8192]);
        assert.equal(
          (await req(path, reader, 'PATCH', { ...edit, maxOutputTokens: 10 })).status,
          403,
        );
        await json(path, admin, 'PATCH', { ...edit, maxOutputTokens: 16384 });
        assert.deepEqual(await saved(reader), [1_000_000, 16384]);
        for (const limits of [
          { contextWindowTokens: 16384 },
          { maxOutputTokens: 1_000_001 },
          { maxOutputTokens: 0 },
          { contextWindowTokens: 4.5 },
        ]) {
          assert.equal(
            (await req(path, admin, 'PATCH', { ...edit, userIds: [], ...limits })).status,
            400,
          );
        }
        assert.deepEqual(await saved(reader), [1_000_000, 16384]);
        await json(path, admin, 'PATCH', { ...edit, contextWindowTokens: null });
        assert.deepEqual(await saved(), [null, 16384]);
        await json(path, admin, 'PATCH', {
          ...edit,
          contextWindowTokens: 131072,
          maxOutputTokens: null,
        });
        assert.deepEqual(await saved(), [131072, null]);
        for (const kind of ['embedding', 'image']) {
          assert.equal(
            (
              await req('/admin/models', admin, 'POST', {
                ...model,
                name: kind,
                kind,
                contextWindowTokens: 65536,
              })
            ).status,
            400,
          );
        }
        await json(path, admin, 'PATCH', { ...edit, kind: 'embedding' });
        assert.deepEqual(await saved(), [null, null]);
        const service = app.kernel.ctx.models;
        assert.equal(service.embeddingSpaceSource(id).apiMode, 'responses');
        app.kernel.ctx.db.run('UPDATE models SET legacy_embedding_fingerprint=1 WHERE id=?', id);
        assert.equal(service.embeddingSpaceSource(id).apiMode, 'chat-completions');
        assert.equal(
          (await req(path, admin, 'PATCH', { ...edit, maxOutputTokens: 32 })).status,
          400,
        );
        await json(path, admin, 'PATCH', { ...edit, kind: 'llm', maxOutputTokens: 32 });
        assert.equal(
          app.kernel.ctx.db.get<{ flag: number }>(
            'SELECT legacy_embedding_fingerprint AS flag FROM models WHERE id=?',
            id,
          )!.flag,
          0,
        );
        await json(`/admin/providers/${providerId}`, admin, 'PATCH', { ...source, apiMode: 'jev' });
        assert.deepEqual(await saved(), [null, null]);
      },
    );
    await t.test(
      'a migrated LLM remains outside the chat picker until enabled by the administrator',
      async () => {
        const { id: sourceId } = await json('/admin/providers', admin, 'POST', {
          name: 'Default Responses',
          baseUrl: mock.url,
        });
        assert.equal(
          (await json('/admin/providers', admin)).find((p: { id: string }) => p.id === sourceId)
            .apiMode,
          'responses',
        );
        const { id } = await json('/admin/models', admin, 'POST', {
          providerId: sourceId,
          name: 'test-text',
          label: 'Migrated',
        });
        app.kernel.ctx.db.run('UPDATE models SET enabled=0,needs_protocol_review=1 WHERE id=?', id);
        app.kernel.ctx.db.run('INSERT INTO model_grants VALUES(?,?)', id, userId);
        const item = async () =>
          ((await json('/admin/models', admin)) as Model[]).find((m) => m.id === id)!;
        const visible = async () =>
          ((await json('/models', reader)) as Model[]).some((m) => m.id === id);
        const baseline = mock.requests.length;
        assert.equal((await item()).needsProtocolReview, true);
        assert.equal(await visible(), false);
        const settings = {
          enabled: false,
          vision: false,
          label: 'Edited label',
          userIds: [userId],
        };
        await json(`/admin/models/${id}`, admin, 'PATCH', settings);
        assert.equal((await item()).needsProtocolReview, true);
        await json(`/admin/models/${id}`, admin, 'PATCH', { ...settings, enabled: true });
        assert.equal((await item()).needsProtocolReview, false);
        assert.equal(await visible(), true);
        assert.equal(mock.requests.length, baseline);
      },
    );
    await t.test(
      'a running request rechecks role and active status against current model grants',
      async () => {
        const account = `/admin/users/${userId}`;
        await json(account, admin, 'PATCH', { role: 'admin' });
        const users: User[] = await json('/admin/users', admin);
        const inFlight = users.find((u) => u.id === userId)!;
        const { models } = app.kernel.ctx;
        assert.equal(inFlight.role, 'admin');
        assert.equal(models.authorize(inFlight, ids[1]).id, ids[1]);
        await json(account, admin, 'PATCH', { role: 'user' });
        assert.throws(() => models.authorize(inFlight, ids[1]), { status: 403 });
        assert.ok(!models.list(inFlight).some((m) => m.id === ids[1]));
        assert.equal(models.authorize(inFlight, ids[0]).id, ids[0]);
        await json(account, admin, 'PATCH', { active: false });
        assert.throws(() => models.authorize(inFlight, ids[0]), { status: 403 });
        assert.deepEqual(models.list(inFlight), []);
      },
    );
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
