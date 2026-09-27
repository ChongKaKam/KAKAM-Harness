import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { mockProvider, imageData } from './mock-provider';
import { accentColors } from '../src/shared/appearance';
const password = 'Test-password-123456';
let app: Awaited<ReturnType<typeof createApp>>;
let mock: Awaited<ReturnType<typeof mockProvider>>;
let server: ReturnType<typeof createServer>;
let config: Config;
let url: string;
let directory: string;
let admin: string;
let alice: string;
let bob: string;
let aliceId: string;
let providerId: string;
let modelId: string;
let conversationId: string;
async function request(
  path: string,
  cookie?: string,
  method = 'GET',
  body?: unknown,
  headers?: Record<string, string>,
) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}
async function json(path: string, cookie?: string, method = 'GET', body?: unknown) {
  const response = await request(path, cookie, method, body);
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function submitStream(id: string, cookie: string, input: unknown) {
  const accepted = await request(`/conversations/${id}/messages`, cookie, 'POST', input);
  assert.equal(accepted.status, 202, await accepted.text());
  return request(`/conversations/${id}/events`, cookie);
}
async function login(username: string) {
  const response = await request('/auth/login', undefined, 'POST', {
    email: `${username}@example.test`,
    password,
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-test-'));
  mock = await mockProvider();
  config = {
    port: 0,
    host: '127.0.0.1',
    dataDir: directory,
    secret: 'integration-test-secret-at-least-32-characters',
    secureCookies: false,
    trustProxy: 0,
  };
  app = await createApp(config);
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await json('/auth/status')).needsSetup, true);
  const registrations = await Promise.all(
    ['admin', 'second'].map((username) =>
      request('/auth/register', undefined, 'POST', {
        email: `${username}@example.test`,
        displayName: username,
        password,
        role: 'admin',
      }),
    ),
  );
  const registered = await Promise.all(registrations.map((r) => r.json()));
  assert.equal(registered.filter((d) => d.user.role === 'admin').length, 1);
  // Avoid relying on which concurrent hash finishes first for later administrator tests.
  const owner = registered.find((d) => d.user.role === 'admin').user.email;
  if (owner !== 'admin@example.test') {
    app.kernel.ctx.db.run(
      "UPDATE users SET role=CASE email WHEN 'admin@example.test' THEN 'admin' ELSE 'user' END",
    );
  }
  admin = await login('admin');
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  if (app) await app.kernel.stop();
  if (mock) await mock.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test('authentication, CSRF and bootstrap protection', async () => {
  assert.equal((await request('/models')).status, 401);
  assert.equal(
    (
      await request('/auth/login', undefined, 'POST', {
        email: 'admin@example.test',
        password: 'wrong',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        '/auth/login',
        undefined,
        'POST',
        { email: 'admin@example.test', password },
        { Origin: 'https://evil.example' },
      )
    ).status,
    403,
  );
  const who = await json('/auth/me', admin);
  assert.equal(who.user.role, 'admin');
  assert.equal(who.user.passwordHash, undefined);
  assert.equal(
    (await request(`/admin/users/${who.user.id}`, admin, 'PATCH', { active: false })).status,
    400,
  );
});
test('create users, enforce admin APIs and keep provider keys encrypted', async () => {
  aliceId = (
    await json('/admin/users', admin, 'POST', {
      email: 'alice@example.test',
      displayName: 'Alice',
      password,
      role: 'user',
    })
  ).id;
  await json('/admin/users', admin, 'POST', {
    email: 'bob@example.test',
    displayName: 'Bob',
    password,
    role: 'user',
  });
  alice = await login('alice');
  bob = await login('bob');
  for (const path of ['/admin/users', '/admin/providers', '/admin/models'])
    assert.equal((await request(path, alice)).status, 403);
  providerId = (
    await json('/admin/providers', admin, 'POST', {
      name: 'Local test',
      baseUrl: mock.url,
      apiKey: 'secret-test-provider-key',
    })
  ).id;
  const providers = await json('/admin/providers', admin);
  assert.equal(providers[0].hasKey, true);
  assert.ok(!JSON.stringify(providers).includes('secret-test-provider-key'));
  const persisted = app.kernel.ctx.db.get<{ encrypted_key: string }>(
    'SELECT encrypted_key FROM providers WHERE id=?',
    providerId,
  )!;
  assert.ok(!persisted.encrypted_key.includes('secret-test-provider-key'));
});
test('discovery is not authorization; whitelist and per-user grants govern access', async () => {
  const found = await json(`/admin/providers/${providerId}/discover`, admin, 'POST');
  assert.ok(found.models.includes('test-vision'));
  assert.deepEqual(await json('/models', admin), []);
  modelId = (
    await json('/admin/models', admin, 'POST', {
      providerId,
      name: 'test-vision',
      label: 'Vision Test',
      vision: true,
    })
  ).id;
  assert.equal((await json('/models', admin)).length, 1);
  assert.deepEqual(await json('/models', alice), []);
  conversationId = (await json('/conversations', alice, 'POST')).id;
  assert.equal(
    (
      await request(`/conversations/${conversationId}/messages`, alice, 'POST', {
        modelId,
        content: 'blocked',
      })
    ).status,
    403,
  );
  await json(`/admin/models/${modelId}`, admin, 'PATCH', {
    label: 'Vision Test',
    enabled: true,
    vision: true,
    userIds: [aliceId],
  });
  assert.equal((await json('/models', alice)).length, 1);
  assert.deepEqual(await json('/models', bob), []);
});
test('stream text/images, retain history, record actual tokens and isolate conversations', async () => {
  const stream = await submitStream(conversationId, alice, {
    modelId,
    content: '描述图片',
    images: [{ name: 'one.png', data: imageData }],
  });
  assert.equal(stream.status, 200);
  const text = await stream.text();
  assert.ok(text.includes('delta'));
  assert.ok(text.includes('done'));
  assert.ok(text.includes('你好'));
  const history = await json(`/conversations/${conversationId}`, alice);
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[1].status, 'complete');
  const upstream = mock.requests.at(-1) as { messages: { content: { type: string }[] }[] };
  assert.equal(upstream.messages[0].content[1].type, 'image_url');
  for (const cookie of [bob, admin]) {
    assert.equal((await request(`/conversations/${conversationId}`, cookie)).status, 404);
    assert.equal((await request(`/conversations/${conversationId}`, cookie, 'DELETE')).status, 404);
  }
  const usage = await json('/usage', alice);
  assert.equal(usage.totals.total, 65);
  assert.equal(usage.rows[0].inputTokens, 23);
  assert.equal((await json(`/usage?userId=${aliceId}`, bob)).totals.total, 0);
  assert.equal((await json('/usage', admin)).totals.total, 65);
  assert.equal(
    (
      await request(`/conversations/${conversationId}/messages`, alice, 'POST', {
        modelId,
        content: 'bad image',
        images: [{ name: 'x.png', data: 'data:image/png;base64,YWJj' }],
      })
    ).status,
    400,
  );
});
test('model disabling revokes access at the API boundary', async () => {
  await json(`/admin/models/${modelId}`, admin, 'PATCH', {
    label: 'Vision Test',
    enabled: false,
    vision: true,
    userIds: [aliceId],
  });
  assert.deepEqual(await json('/models', alice), []);
  assert.equal(
    (
      await request(`/conversations/${conversationId}/messages`, alice, 'POST', {
        modelId,
        content: 'blocked now',
      })
    ).status,
    403,
  );
  await json(`/admin/models/${modelId}`, admin, 'PATCH', {
    label: 'Vision Test',
    enabled: true,
    vision: true,
    userIds: [aliceId],
  });
});
test('optional feature disposal removes routes and preserves private data', async () => {
  const prompt = await json('/prompts', alice, 'POST', {
    title: 'Test',
    content: 'My private prompt',
  });
  assert.deepEqual(await json('/prompts', bob), []);
  assert.equal(
    (await request('/features/prompts', alice, 'PATCH', { enabled: false })).status,
    403,
  );
  assert.equal((await request('/features/chat', admin, 'PATCH', { enabled: false })).status, 400);
  await json('/features/prompts', admin, 'PATCH', { enabled: false });
  assert.equal((await request('/prompts', alice)).status, 404);
  await json('/features/prompts', admin, 'PATCH', { enabled: true });
  assert.equal((await json('/prompts', alice))[0].id, prompt.id);
});
test('stopping a stream retains partial output, records missing usage honestly and releases the request lock', async () => {
  const slow = (
    await json('/admin/models', admin, 'POST', { providerId, name: 'slow', label: 'Slow' })
  ).id;
  const convo = (await json('/conversations', admin, 'POST')).id;
  const stream = await submitStream(convo, admin, {
    modelId: slow,
    content: 'slow',
  });
  const reader = stream.body!.getReader();
  let firstText = '';
  while (!firstText.includes('delta'))
    firstText += new TextDecoder().decode((await reader.read()).value);
  assert.equal(
    (
      await request(`/conversations/${convo}/messages`, admin, 'POST', {
        modelId: slow,
        content: 'overlap',
      })
    ).status,
    409,
  );
  await json(`/conversations/${convo}/stop`, admin, 'POST');
  while (!(await reader.read()).done) {
    /* drain */
  }
  const saved = await json(`/conversations/${convo}`, admin);
  assert.equal(saved.messages[1].status, 'cancelled');
  assert.ok(saved.messages[1].content.length);
  const usage = await json('/usage', admin);
  assert.equal(usage.totals.unreported, 1);
});
test('missing usage, truncated SSE and provider failures are represented accurately', async () => {
  for (const name of ['no-usage', 'broken', 'upstream-error']) {
    const id = (await json('/admin/models', admin, 'POST', { providerId, name, label: name })).id;
    const convo = (await json('/conversations', admin, 'POST')).id;
    const response = await submitStream(convo, admin, {
      modelId: id,
      content: name,
    });
    const stream = await response.text();
    assert.ok(!stream.includes('sensitive upstream details'));
    const saved = await json(`/conversations/${convo}`, admin);
    assert.equal(saved.messages[1].status, name === 'no-usage' ? 'complete' : 'error');
  }
  const usage = await json('/usage', admin);
  assert.equal(usage.totals.total, 65);
  assert.equal(usage.totals.unreported, 4);
});
test('disabling a user immediately invalidates existing sessions', async () => {
  await json(`/admin/users/${aliceId}`, admin, 'PATCH', { active: false });
  assert.equal((await request('/models', alice)).status, 401);
  assert.equal(
    (await request('/auth/login', undefined, 'POST', { email: 'alice@example.test', password }))
      .status,
    401,
  );
});
test('data and plugin state survive app restart', async () => {
  await json('/features/prompts', admin, 'PATCH', { enabled: false });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  await app.kernel.stop();
  app = await createApp(config);
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  assert.equal((await json('/admin/models', admin)).length, 5);
  assert.equal((await request('/prompts', admin)).status, 404);
  assert.equal((await json('/usage', admin)).totals.total, 65);
});
test('public registration cannot elevate roles, emails are unique, and preferences remain private', async () => {
  assert.equal((await json('/auth/status')).needsSetup, false);
  const registered = await request('/auth/register', undefined, 'POST', {
    email: 'new-member@example.test',
    displayName: 'New',
    password,
    role: 'admin',
  });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).user.role, 'user');
  const member = registered.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await request('/admin/providers', member)).status, 403);
  assert.equal(
    (
      await request('/auth/register', undefined, 'POST', {
        email: 'NEW-MEMBER@example.test',
        displayName: 'New',
        password,
      })
    ).status,
    409,
  );
  assert.equal((await request('/preferences')).status, 401);
  assert.deepEqual(await json('/preferences', member), {
    theme: 'system',
    assistantIcon: null,
    accentColor: 'sage',
    colorPattern: 'natural',
  });
  await json('/preferences', member, 'PATCH', { theme: 'dark', assistantIcon: imageData });
  assert.deepEqual(await json('/preferences', member), {
    theme: 'dark',
    assistantIcon: imageData,
    accentColor: 'sage',
    colorPattern: 'natural',
  });
  for (const accent of accentColors) {
    const value = {
      theme: 'dark',
      assistantIcon: imageData,
      accentColor: accent.id,
      colorPattern: accent.group,
    };
    const legacyInput = { theme: 'dark', assistantIcon: imageData, accentColor: accent.id };
    assert.deepEqual(await json('/preferences', member, 'PATCH', legacyInput), value);
    assert.deepEqual(await json('/preferences', member), value);
  }
  // Older clients updating the theme must preserve the chosen accent.
  await json('/preferences', member, 'PATCH', { theme: 'light', assistantIcon: imageData });
  assert.equal((await json('/preferences', member)).accentColor, 'soft-pink');
  assert.equal(
    (
      await request('/preferences', member, 'PATCH', {
        theme: 'dark',
        assistantIcon: null,
        accentColor: 'url(evil)',
      })
    ).status,
    400,
  );
  assert.deepEqual(await json('/preferences', admin), {
    theme: 'system',
    assistantIcon: null,
    accentColor: 'sage',
    colorPattern: 'natural',
  });
  assert.equal(
    (
      await request('/preferences', member, 'PATCH', {
        theme: 'light',
        assistantIcon: 'data:image/svg+xml;base64,PHN2Zz4=',
      })
    ).status,
    400,
  );
});
test('pattern and component colors validate inputs and enforce ownership', async () => {
  const before = await json('/preferences', admin);
  for (const colorPattern of ['classic', 'natural']) {
    const result = await json('/preferences', admin, 'PATCH', { ...before, colorPattern });
    assert.equal(result.colorPattern, colorPattern);
    assert.equal((await json('/preferences', admin)).colorPattern, colorPattern);
  }
  assert.equal(
    (await request('/preferences', admin, 'PATCH', { ...before, colorPattern: 'unknown' })).status,
    400,
  );
  await json('/features/prompts', admin, 'PATCH', { enabled: true });
  const chat = await json('/conversations', admin, 'POST');
  const card = await json('/prompts', admin, 'POST', { title: 'Colored card', content: 'Content' });
  for (const value of [6, 8, null]) {
    await json(`/conversations/${chat.id}`, admin, 'PATCH', { colorSlot: value });
    await json(`/prompts/${card.id}/color`, admin, 'PATCH', { colorSlot: value });
    assert.equal(
      (await json('/conversations', admin)).find((item: { id: string }) => item.id === chat.id)
        .colorSlot,
      value,
    );
    assert.equal(
      (await json('/prompts', admin)).find((item: { id: string }) => item.id === card.id).colorSlot,
      value,
    );
  }
  for (const value of [-1, 64, 1.5, 'red']) {
    assert.equal(
      (await request(`/conversations/${chat.id}`, admin, 'PATCH', { colorSlot: value })).status,
      400,
    );
    assert.equal(
      (await request(`/prompts/${card.id}/color`, admin, 'PATCH', { colorSlot: value })).status,
      400,
    );
  }
  for (const path of [`/conversations/${chat.id}`, `/prompts/${card.id}/color`]) {
    assert.equal((await request(path, bob, 'PATCH', { colorSlot: 2 })).status, 404);
    assert.equal((await request(path, undefined, 'PATCH', { colorSlot: 2 })).status, 401);
  }
  await json(`/conversations/${chat.id}`, admin, 'PATCH', { title: 'Renamed', colorSlot: 6 });
  assert.equal(
    (await json('/conversations', admin)).find((item: { id: string }) => item.id === chat.id).title,
    'Renamed',
  );
  await json('/features/prompts', admin, 'PATCH', { enabled: false });
});

test('personal avatars persist, validate raster uploads and only update the signed-in user', async () => {
  const owner = (await json('/auth/me', admin)).user;
  assert.equal(
    (await request('/auth/avatar', undefined, 'PATCH', { avatar: imageData })).status,
    401,
  );
  for (const avatar of [
    'https://example.com/a.png',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,AAAA',
    imageData + 'A'.repeat(710_000),
  ])
    assert.equal((await request('/auth/avatar', admin, 'PATCH', { avatar })).status, 400);
  assert.equal(
    (await request('/auth/avatar', bob, 'PATCH', { avatar: imageData, userId: owner.id })).status,
    400,
  );
  const saved = await json('/auth/avatar', bob, 'PATCH', { avatar: imageData });
  assert.equal(saved.user.avatar, imageData);
  assert.equal((await json('/auth/me', bob)).user.avatar, imageData);
  assert.equal((await json('/auth/me', admin)).user.avatar, owner.avatar);
  const signedIn = await login('bob');
  assert.equal((await json('/auth/me', signedIn)).user.avatar, imageData);
  await json('/auth/avatar', signedIn, 'PATCH', { avatar: null });
  assert.equal((await json('/auth/me', bob)).user.avatar, null);
});
test('provider testing uses unsaved protocol and saved credentials; Responses chat records scoped activity', async () => {
  const test = { id: providerId, baseUrl: mock.url, apiMode: 'responses', model: 'test-vision' };
  assert.equal((await request('/admin/providers/test', bob, 'POST', test)).status, 403);
  const result = await json('/admin/providers/test', admin, 'POST', test);
  assert.equal(result.ok, true);
  assert.equal(result.apiMode, 'responses');
  assert.equal((await json('/admin/providers', admin))[0].apiMode, 'chat-completions');
  await json(`/admin/providers/${providerId}`, admin, 'PATCH', {
    name: 'Local test',
    baseUrl: mock.url,
    apiMode: 'responses',
  });
  assert.equal((await json('/admin/providers', admin))[0].hasKey, true);
  const convo = (await json('/conversations', admin, 'POST')).id;
  const response = await submitStream(convo, admin, {
    modelId,
    content: 'responses',
    reasoningEffort: 'xhigh',
  });
  await response.text();
  assert.equal((await json(`/conversations/${convo}`, admin)).messages[1].status, 'complete');
  assert.equal(
    (mock.requests.at(-1) as { reasoning: { effort: string } }).reasoning.effort,
    'xhigh',
  );
  const usage = await json('/usage', admin);
  assert.equal(usage.totals.total, 195);
  assert.equal(
    usage.activity.reduce((sum: number, row: { total: number }) => sum + row.total, 0),
    195,
  );
  assert.deepEqual((await json('/usage', bob)).activity, []);
});

test('passwords accept short, Unicode and long values without composition rules, including login and changes', async () => {
  for (const [index, password] of ['1', ' 中文 🙂 ', 'a'.repeat(600)].entries()) {
    const username = `free-password-${index}`;
    const registered = await request('/auth/register', undefined, 'POST', {
      email: `${username}@example.test`,
      displayName: 'Member',
      password,
    });
    assert.equal(registered.status, 201);
    const user = (await registered.json()).user;
    assert.equal(user.role, 'user');
    const login = await request('/auth/login', undefined, 'POST', {
      email: `${username}@example.test`,
      password,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    await json('/auth/me', cookie, 'PATCH', {
      displayName: 'Member',
      currentPassword: password,
      newPassword: '短',
    });
    const changed = await request('/auth/login', undefined, 'POST', {
      email: `${username}@example.test`,
      password: '短',
    });
    assert.equal(changed.status, 200);
  }
});

test('both protocols continue after all viewers disconnect, resume snapshots, deduplicate submits and isolate subscribers', async () => {
  const slow = (await json('/admin/models', admin)).find(
    (model: { name: string }) => model.name === 'slow',
  ).id;
  for (const apiMode of ['chat-completions', 'responses']) {
    await json(`/admin/providers/${providerId}`, admin, 'PATCH', {
      name: 'Local test',
      baseUrl: mock.url,
      apiMode,
    });
    const convo = (await json('/conversations', admin, 'POST')).id;
    const input = { modelId: slow, content: 'continue offline', requestId: randomUUID() };
    const before = mock.requests.length;
    const accepted = await request(`/conversations/${convo}/messages`, admin, 'POST', input);
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).messageId, input.requestId);
    const abort = new AbortController();
    const viewer = await fetch(`${url}/api/conversations/${convo}/events`, {
      headers: { cookie: admin },
      signal: abort.signal,
    });
    assert.match(viewer.headers.get('content-type')!, /text\/event-stream/);
    const reader = viewer.body!.getReader();
    let received = '';
    while (!received.includes('delta'))
      received += new TextDecoder().decode((await reader.read()).value);
    abort.abort();
    await reader.cancel().catch(() => {});
    assert.equal((await json(`/conversations/${convo}`, admin)).messages[1].status, 'streaming');
    assert.equal((await request(`/conversations/${convo}/events`, bob)).status, 404);
    assert.equal((await request(`/conversations/${convo}/stop`, bob, 'POST')).status, 404);
    assert.equal(
      (await request(`/conversations/${convo}/messages`, admin, 'POST', input)).status,
      202,
    );
    const resumed = await (await request(`/conversations/${convo}/events`, admin)).text();
    assert.ok(resumed.includes('snapshot') && resumed.includes('done'));
    const saved = (await json(`/conversations/${convo}`, admin)).messages;
    assert.equal(saved.length, 2);
    assert.equal(saved[1].status, 'complete');
    assert.equal(saved[1].content, '慢速回复 '.repeat(50));
    assert.equal(mock.requests.length, before + 1);
    assert.equal(
      (await request(`/conversations/${convo}/messages`, admin, 'POST', input)).status,
      202,
    );
    assert.equal(mock.requests.length, before + 1);
    assert.equal(
      (await json('/usage', admin)).rows.filter((row: { id: string }) => row.id === input.requestId)
        .length,
      1,
    );
  }
});

test('kernel shutdown settles detached jobs before closing storage', async () => {
  const slow = (await json('/admin/models', admin)).find(
    (model: { name: string }) => model.name === 'slow',
  ).id;
  const convo = (await json('/conversations', admin, 'POST')).id;
  await json(`/conversations/${convo}/messages`, admin, 'POST', {
    modelId: slow,
    content: 'shutdown',
  });
  await app.kernel.stop();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(directory, 'kakam.sqlite'), { readOnly: true });
  assert.equal(
    db
      .prepare("SELECT status FROM messages WHERE conversation_id=? AND role='assistant'")
      .get(convo)!.status,
    'cancelled',
  );
  db.close();
});
