import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app';
import type { Message, Conversation } from '../src/shared/types';

let application: Awaited<ReturnType<typeof createApp>>;
let server: ReturnType<typeof createServer>;
let upstream: ReturnType<typeof createServer>;
let directory: string;
let url: string;
let admin: string;
let member: string;
let modelId: string;
const streams = new Map<string, ServerResponse>();
const calls: string[] = [];
async function request(path: string, cookie = admin, method = 'GET', body?: unknown) {
  return fetch(`${url}/api${path}`, {
    method,
    headers: { cookie, 'Content-Type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}
async function json(path: string, cookie = admin, method = 'GET', body?: unknown) {
  const response = await request(path, cookie, method, body);
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the local fixture');
}
async function start(maxConcurrentChats?: number) {
  application = await createApp({
    dataDir: directory,
    secret: 'chat-concurrency-test-secret-at-least-32-characters',
    host: '127.0.0.1',
    port: 0,
    secureCookies: false,
    trustProxy: 0,
    maxConcurrentChats,
  });
  server = createServer(application.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function closeApp() {
  await application.kernel.stop();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'drift-chat-concurrency-'));
  // Hold each local stream until explicitly completed, failed or cancelled: no timing race.
  upstream = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'held' }, { id: 'other' }] }));
      return;
    }
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    const content: string = body.messages.at(-1).content;
    calls.push(content);
    streams.set(content, res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    res.on('close', () => {
      if (streams.get(content) === res) streams.delete(content);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  await start();
  const registration = await request('/auth/register', '', 'POST', {
    email: 'admin@example.test',
    displayName: 'Admin',
    password: 'test',
  });
  assert.equal(registration.status, 201);
  admin = registration.headers.get('set-cookie')!.split(';')[0];
  const registered = await request('/auth/register', '', 'POST', {
    email: 'member@example.test',
    displayName: 'Member',
    password: 'test',
  });
  member = registered.headers.get('set-cookie')!.split(';')[0];
  const memberId = (await registered.json()).user.id;
  const provider = await json('/admin/providers', admin, 'POST', {
    name: 'Local held streams',
    baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
    apiKey: 'fixture',
  });
  modelId = (
    await json('/admin/models', admin, 'POST', {
      providerId: provider.id,
      name: 'held',
      label: 'Held',
    })
  ).id;
  await json(`/admin/models/${modelId}`, admin, 'PATCH', {
    label: 'Held',
    enabled: true,
    vision: false,
    userIds: [memberId],
  });
});
after(async () => {
  if (application) await closeApp();
  if (upstream)
    await new Promise<void>((resolve) => {
      upstream.close(() => resolve());
      upstream.closeAllConnections();
    });
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('five chats per user, independent subscribers and cancellation, idempotency and slot release', async () => {
  const chats = await Promise.all(
    Array.from({ length: 7 }, () => json('/conversations', admin, 'POST')),
  );
  const inputs = chats
    .slice(0, 5)
    .map((_, index) => ({ modelId, content: `run-${index}`, requestId: randomUUID() }));
  const accepted = await Promise.all(
    inputs.map((input, index) =>
      request(`/conversations/${chats[index].id}/messages`, admin, 'POST', input),
    ),
  );
  assert.deepEqual(
    accepted.map((r) => r.status),
    [202, 202, 202, 202, 202],
  );
  await waitFor(() => streams.size === 5);
  const rows: Conversation[] = await json('/conversations');
  assert.equal(rows.filter((row) => row.generating).length, 5);
  assert.equal(
    (await request(`/conversations/${chats[0].id}/messages`, admin, 'POST', inputs[0])).status,
    202,
  );
  assert.equal(calls.length, 5, 'duplicate at capacity does not make another model call');
  assert.equal(
    (
      await request(`/conversations/${chats[0].id}/messages`, admin, 'POST', {
        modelId,
        content: 'overlap',
      })
    ).status,
    409,
  );
  const full = await request(`/conversations/${chats[5].id}/messages`, admin, 'POST', {
    modelId,
    content: 'sixth',
  });
  assert.equal(full.status, 409);
  assert.match((await full.json()).error, /5/);
  assert.equal((await json(`/conversations/${chats[5].id}`)).messages.length, 0);
  const another = await json('/conversations', member, 'POST');
  assert.equal(
    (
      await request(`/conversations/${another.id}/messages`, member, 'POST', {
        modelId,
        content: 'member',
      })
    ).status,
    202,
  );
  assert.equal((await request(`/conversations/${chats[0].id}/stop`, member, 'POST')).status, 404);
  const viewer = new AbortController();
  const response = await fetch(`${url}/api/conversations/${chats[1].id}/events`, {
    headers: { cookie: admin },
    signal: viewer.signal,
  });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /snapshot/);
  assert.match(first, /run-1/);
  assert.doesNotMatch(first, /run-0/);
  viewer.abort();
  await reader.cancel().catch(() => {});
  await json(`/conversations/${chats[0].id}/stop`, admin, 'POST');
  await waitFor(
    async () => (await json(`/conversations/${chats[0].id}`)).messages[1].status === 'cancelled',
  );
  assert.equal((await json(`/conversations/${chats[1].id}`)).messages[1].status, 'streaming');
  assert.equal(
    (
      await request(`/conversations/${chats[5].id}/messages`, admin, 'POST', {
        modelId,
        content: 'sixth',
      })
    ).status,
    202,
  );
  await waitFor(() => streams.has('sixth'));
  streams
    .get('run-1')!
    .end(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
    );
  await waitFor(
    async () => (await json(`/conversations/${chats[1].id}`)).messages[1].status === 'complete',
  );
  assert.equal(
    (
      await request(`/conversations/${chats[6].id}/messages`, admin, 'POST', {
        modelId,
        content: 'seventh',
      })
    ).status,
    202,
  );
  streams.get('run-2')!.end();
  await waitFor(
    async () => (await json(`/conversations/${chats[2].id}`)).messages[1].status === 'error',
  );
  assert.equal(
    (
      await request(`/conversations/${chats[0].id}/messages`, admin, 'POST', {
        modelId,
        content: 'after-error',
      })
    ).status,
    202,
  );
  for (const chat of chats) await json(`/conversations/${chat.id}/stop`, admin, 'POST');
  await json(`/conversations/${another.id}/stop`, member, 'POST');
  await waitFor(
    async () => !(await json('/conversations')).some((row: Conversation) => row.generating),
  );
});

test('configured concurrency cap and shutdown save every detached chat', async () => {
  await closeApp();
  await start(2);
  const chats = await Promise.all(
    Array.from({ length: 3 }, () => json('/conversations', admin, 'POST')),
  );
  for (let index = 0; index < 2; index++) {
    assert.equal(
      (
        await request(`/conversations/${chats[index].id}/messages`, admin, 'POST', {
          modelId,
          content: `shutdown-${index}`,
        })
      ).status,
      202,
    );
  }
  const full = await request(`/conversations/${chats[2].id}/messages`, admin, 'POST', {
    modelId,
    content: 'configured-limit',
  });
  assert.equal(full.status, 409);
  assert.match((await full.json()).error, /2/);
  await closeApp();
  await start(2);
  for (const chat of chats.slice(0, 2)) {
    const saved: Message[] = (await json(`/conversations/${chat.id}`)).messages;
    assert.equal(saved[1].status, 'cancelled');
  }
  assert.equal(
    (
      await request(`/conversations/${chats[2].id}/messages`, admin, 'POST', {
        modelId,
        content: 'after-restart',
      })
    ).status,
    202,
  );
});
