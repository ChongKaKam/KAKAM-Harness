import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server/app';

const adminPath = '/admin/openai-gateway';
const sdkPath = '/openai/v1';
const providerId = randomUUID();
const otherProviderId = randomUUID();
const officialBase = 'https://api.openai.com/v1';
const upstreamKey = 'fixture-upstream-secret';
const localFetch = globalThis.fetch;
const upstreamCalls: Request[] = [];
let respond: (request: Request) => Promise<Response> | Response;
let app: Awaited<ReturnType<typeof createApp>>;
let server: ReturnType<typeof createServer>;
let directory: string;
let origin: string;
let owner: Awaited<ReturnType<typeof register>>;
let other: Awaited<ReturnType<typeof register>>;

function request(
  path: string,
  headers: Record<string, string> = {},
  body?: object,
  method = body ? 'POST' : 'GET',
) {
  return localFetch(origin + '/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(8000),
  });
}

async function register(name: string) {
  const response = await request(
    '/auth/register',
    {},
    { email: name + '@example.test', displayName: name, password: 'fixture' },
  );
  assert.equal(response.status, 201);
  return {
    id: (await response.json()).user.id as string,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
}

async function issue(name: string) {
  const response = await request(
    adminPath + '/keys',
    { cookie: owner.cookie },
    { name, providerId },
  );
  assert.equal(response.status, 201);
  const { key } = await response.json();
  assert.equal(typeof key, 'string');
  assert.notEqual(key, upstreamKey);
  return key as string;
}

const bearer = (key: string) => ({ authorization: 'Bearer ' + key });

function latestUsage() {
  return {
    ...app.kernel.ctx.db.get<Record<string, number | null>>(
      'SELECT input_tokens,output_tokens,total_tokens FROM usage WHERE user_id=? ORDER BY rowid DESC LIMIT 1',
      owner.id,
    ),
  };
}

function latestMetrics() {
  const row = app.kernel.ctx.db.get<{ cached: number | null; durationMs: number }>(
    `SELECT m.cached_input_tokens AS cached, m.duration_ms AS durationMs
     FROM usage u LEFT JOIN openai_gateway_metrics m ON m.usage_id=u.id
     WHERE u.user_id=? ORDER BY u.rowid DESC LIMIT 1`,
    owner.id,
  );
  assert.ok(row && Number.isSafeInteger(row.durationMs) && row.durationMs >= 0);
  return row;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-openai-gateway-'));
  // Only our client helper may open a socket, and it always targets the loopback app.
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.method === 'GET' && req.url.endsWith('/models')) return Response.json({ data: [] });
    upstreamCalls.push(req);
    return respond(req);
  };
  app = await createApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: directory,
    secret: 'gateway-fixture-secret-at-least-32-characters',
    secureCookies: false,
    trustProxy: 0,
  });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  owner = await register('owner');
  other = await register('other');
  const { db, models } = app.kernel.ctx;
  for (const [id, url] of [
    [providerId, officialBase],
    [otherProviderId, 'https://example.test/v1'],
  ])
    db.run(
      'INSERT INTO providers(id,name,base_url,encrypted_key,api_mode) VALUES(?,?,?,?,?)',
      id,
      id,
      url,
      models.encrypt(upstreamKey),
      'responses',
    );
  for (const [name, id, enabled, kind] of [
    ['allowed', providerId, 1, 'llm'],
    ['disabled', providerId, 0, 'llm'],
    ['image', providerId, 1, 'image'],
    ['other-source', otherProviderId, 1, 'llm'],
  ] as const)
    db.run(
      'INSERT INTO models(id,provider_id,name,label,enabled,kind,tool_calling) VALUES(?,?,?,?,?,?,1)',
      randomUUID(),
      id,
      name,
      name,
      enabled,
      kind,
    );
});

after(async () => {
  try {
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    if (app) await app.kernel.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  } finally {
    globalThis.fetch = localFetch;
  }
});

test('owner-only issuance, one-time plaintext, SDK bearer isolation and revocation', async () => {
  const cookie = { cookie: owner.cookie };
  assert.equal((await request(adminPath)).status, 401);
  assert.equal((await request(adminPath, { cookie: other.cookie })).status, 403);
  const invalidSource = await request(adminPath + '/keys', cookie, {
    name: 'bad',
    providerId: otherProviderId,
  });
  assert.ok(invalidSource.status >= 400 && invalidSource.status < 500);
  const key = await issue('laptop');
  const listing = await (await request(adminPath, cookie)).json();
  assert.deepEqual(
    listing.providers.map((p: { id: string }) => p.id),
    [providerId],
  );
  assert.ok(!JSON.stringify(listing).includes(key));
  assert.ok(!JSON.stringify(listing).includes(upstreamKey));
  const device = listing.keys.find((entry: { name: string }) => entry.name === 'laptop');
  assert.ok(device.prefix && key.startsWith(device.prefix));
  const stored = app.kernel.ctx.db.get<Record<string, unknown>>(
    'SELECT * FROM openai_gateway_keys WHERE id=?',
    device.id,
  );
  assert.ok(stored);
  assert.ok(!JSON.stringify(stored).includes(key));
  assert.equal((await request(sdkPath + '/models', cookie)).status, 401);
  assert.equal((await request(adminPath, bearer(key))).status, 401);
  assert.equal((await request(sdkPath + '/models', bearer(upstreamKey))).status, 401);
  const models = await (await request(sdkPath + '/models', bearer(key))).json();
  assert.equal(models.object, 'list');
  assert.deepEqual(
    models.data.map((m: { id: string }) => m.id),
    ['allowed'],
  );
  const { db } = app.kernel.ctx;
  db.run("UPDATE users SET role='admin' WHERE id=?", other.id);
  try {
    const otherAdmin = { cookie: other.cookie };
    assert.deepEqual((await (await request(adminPath, otherAdmin)).json()).keys, []);
    assert.equal(
      (await request(adminPath + '/keys/' + device.id, otherAdmin, {}, 'DELETE')).status,
      404,
    );
    for (const update of ["role='user'", 'active=0']) {
      db.run('UPDATE users SET ' + update + ' WHERE id=?', owner.id);
      assert.ok([401, 403].includes((await request(sdkPath + '/models', bearer(key))).status));
      db.run("UPDATE users SET role='admin',active=1 WHERE id=?", owner.id);
    }
  } finally {
    db.run("UPDATE users SET role='admin',active=1 WHERE id=?", owner.id);
    db.run("UPDATE users SET role='user' WHERE id=?", other.id);
  }
  assert.equal((await request(adminPath + '/keys/' + device.id, cookie, {}, 'DELETE')).status, 200);
  assert.equal((await request(sdkPath + '/models', bearer(key))).status, 401);
});

test('model and source changes apply before the next upstream request', async () => {
  const headers = bearer(await issue('scoped'));
  const start = upstreamCalls.length;
  for (const model of ['disabled', 'image', 'other-source']) {
    const response = await request(sdkPath + '/responses', headers, { model, input: 'hello' });
    assert.ok(response.status >= 400 && response.status < 500);
  }
  const { db } = app.kernel.ctx;
  db.run('UPDATE providers SET base_url=? WHERE id=?', 'https://wrong.example.test/v1', providerId);
  try {
    assert.ok(
      (await request(sdkPath + '/responses', headers, { model: 'allowed', input: 'hello' }))
        .status >= 400,
    );
  } finally {
    db.run('UPDATE providers SET base_url=? WHERE id=?', officialBase, providerId);
  }
  assert.equal(upstreamCalls.length, start);
});

test('tool declarations, tool continuations and image inputs respect model capabilities', async () => {
  const headers = bearer(await issue('capabilities'));
  const { db } = app.kernel.ctx;
  const start = upstreamCalls.length;
  db.run('UPDATE models SET tool_calling=0 WHERE provider_id=? AND name=?', providerId, 'allowed');
  try {
    for (const body of [
      {
        input: 'hello',
        tools: [{ type: 'function', name: 'read_version', parameters: { type: 'object' } }],
      },
      { input: [{ type: 'function_call_output', call_id: 'call_fixture', output: '1.0' }] },
      {
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }],
          },
        ],
      },
    ])
      assert.equal(
        (await request(sdkPath + '/responses', headers, { model: 'allowed', ...body })).status,
        400,
      );
  } finally {
    db.run(
      'UPDATE models SET tool_calling=1 WHERE provider_id=? AND name=?',
      providerId,
      'allowed',
    );
  }
  assert.equal(upstreamCalls.length, start);
});

test('Responses uses server credentials and supports an explicit two-turn function-call replay', async () => {
  const headers = {
    ...bearer(await issue('tool client')),
    cookie: owner.cookie,
    'x-api-key': 'untrusted-client-value',
  };
  const tools = [
    {
      type: 'function',
      name: 'read_version',
      description: 'Read the current fixture version',
      parameters: { type: 'object', properties: {} },
    },
  ];
  const call = {
    type: 'function_call',
    call_id: 'call_fixture',
    name: 'read_version',
    arguments: '{}',
  };
  const result = { type: 'function_call_output', call_id: call.call_id, output: '1.0' };
  const prompt = { role: 'user', content: 'What version is installed?' };
  const initial = { model: 'allowed', input: [prompt], tools };
  const replay = { ...initial, input: [prompt, call, result] };
  const start = upstreamCalls.length;
  const sent: Record<string, unknown>[] = [];
  respond = async (req) => {
    sent.push(await req.json());
    return Response.json(
      {
        id: 'resp_fixture',
        object: 'response',
        status: 'completed',
        output: sent.length === 1 ? [call] : [],
        usage: {
          input_tokens: 6,
          output_tokens: 2,
          total_tokens: 8,
          input_tokens_details: { cached_tokens: sent.length === 1 ? 0 : 0.5 },
        },
      },
      { headers: { 'set-cookie': 'should-not-reach-client=true' } },
    );
  };
  for (const [index, body] of [initial, replay].entries()) {
    const response = await request(sdkPath + '/responses', headers, body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), null);
    const payload = await response.json();
    if (index === 0) assert.deepEqual(payload.output, [call]);
    assert.equal(latestMetrics().cached, index === 0 ? 0 : null);
    assert.deepEqual(sent[index].input, body.input);
    assert.deepEqual(sent[index].tools, tools);
    assert.equal(sent[index].store, false);
  }
  for (const req of upstreamCalls.slice(start)) {
    assert.equal(req.url, officialBase + '/responses');
    assert.equal(req.headers.get('authorization'), 'Bearer ' + upstreamKey);
    assert.equal(req.headers.get('cookie'), null);
    assert.equal(req.headers.get('x-api-key'), null);
  }
  assert.equal(upstreamCalls.length, start + 2);
  const rejected = await request(sdkPath + '/responses', headers, {
    ...initial,
    previous_response_id: 'resp_other_owner',
  });
  assert.ok(rejected.status >= 400 && rejected.status < 500);
  assert.equal(upstreamCalls.length, start + 2);
});

test('Chat Completions delivers SSE before completion and records the final upstream usage once', async () => {
  const headers = bearer(await issue('streaming client'));
  const { db } = app.kernel.ctx;
  const count = () =>
    db.get<{ n: number }>('SELECT count(*) AS n FROM usage WHERE user_id=?', owner.id)!.n;
  const before = count();
  const event = (body: object | string) =>
    new TextEncoder().encode(
      'data: ' + (typeof body === 'string' ? body : JSON.stringify(body)) + '\n\n',
    );
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  respond = (req) => {
    assert.equal(req.url, officialBase + '/chat/completions');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(
            event({
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: 'early' } }],
            }),
          );
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const response = await request(sdkPath + '/chat/completions', headers, {
    model: 'allowed',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('early')) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await delay(30);
    controller.enqueue(
      event({
        choices: [],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 1,
          total_tokens: 3,
          prompt_tokens_details: { cached_tokens: 1 },
        },
      }),
    );
    controller.enqueue(
      event({
        choices: [],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 5,
          total_tokens: 13,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      }),
    );
    controller.enqueue(event({ choices: [], usage: { total_tokens: 13 } }));
    controller.enqueue(event('[DONE]'));
    controller.close();
  }
  for (let part = await reader.read(); !part.done; part = await reader.read())
    text += decoder.decode(part.value, { stream: true });
  assert.match(text, /\[DONE\]/);
  assert.equal(count(), before + 1);
  assert.deepEqual(latestUsage(), { input_tokens: 8, output_tokens: 5, total_tokens: 13 });
  const metrics = latestMetrics();
  assert.equal(metrics.cached, 6);
  assert.ok(
    metrics.durationMs >= 20,
    'Streaming duration includes time before the last usage frame',
  );
});

function lastUsageRowId() {
  return app.kernel.ctx.db.get<{ id: number }>('SELECT COALESCE(MAX(rowid),0) AS id FROM usage')!
    .id;
}

async function waitForNextUsage(afterId: number) {
  for (let i = 0; i < 100; i++) {
    const result = app.kernel.ctx.db.get<{
      status: string;
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
    }>(
      'SELECT status,input_tokens,output_tokens,total_tokens FROM usage WHERE rowid>? AND user_id=? ORDER BY rowid LIMIT 1',
      afterId,
      owner.id,
    );
    if (result) return { ...result };
    await delay(10);
  }
  assert.fail('Expected a gateway usage row after the client disconnected');
}

test('Responses commits completion when the SDK disconnects at response.completed before upstream EOF', async () => {
  const headers = bearer(await issue('responses terminal'));
  const afterId = lastUsageRowId();
  const terminal = {
    type: 'response.completed',
    response: {
      id: 'resp_done',
      status: 'completed',
      usage: {
        input_tokens: 14,
        output_tokens: 3,
        total_tokens: 17,
        input_tokens_details: { cached_tokens: 10 },
      },
    },
  };
  respond = (req) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.completed\ndata: ' + JSON.stringify(terminal) + '\n\n',
            ),
          );
          // Leave the body open until the gateway releases the completed request or its client disconnects.
          req.signal.addEventListener('abort', () => controller.error(req.signal.reason), {
            once: true,
          });
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const response = await request(sdkPath + '/responses', headers, {
    model: 'allowed',
    input: 'hello',
    stream: true,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('\n\n')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    received += decoder.decode(value, { stream: true });
  }
  assert.match(received, /"type":"response.completed"/);
  await reader.cancel();
  assert.deepEqual(await waitForNextUsage(afterId), {
    status: 'complete',
    input_tokens: 14,
    output_tokens: 3,
    total_tokens: 17,
  });
  assert.equal(latestMetrics().cached, 10);
});

test('disconnecting an SDK stream cancels its upstream request', async () => {
  const headers = bearer(await issue('disconnect'));
  const afterId = lastUsageRowId();
  let signal: AbortSignal | undefined;
  respond = (req) => {
    signal = req.signal;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
          req.signal.addEventListener('abort', () => controller.error(req.signal.reason), {
            once: true,
          });
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const response = await request(sdkPath + '/chat/completions', headers, {
    model: 'allowed',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.ok(signal);
  const cancelled = once(signal, 'abort', { signal: AbortSignal.timeout(3000) });
  await reader.cancel();
  await cancelled;
  assert.equal((await waitForNextUsage(afterId)).status, 'cancelled');
  assert.equal(latestMetrics().cached, null);
});

test('upstream error does not reflect credentials and missing usage remains NULL', async () => {
  const headers = bearer(await issue('error handling'));
  respond = () =>
    Response.json(
      { error: { message: 'Incorrect API key provided: ' + upstreamKey } },
      { status: 401 },
    );
  const response = await request(sdkPath + '/chat/completions', headers, {
    model: 'allowed',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.ok(response.status >= 400);
  const error = await response.json();
  assert.ok(error.error.message);
  assert.ok(!JSON.stringify(error).includes(upstreamKey));
  assert.deepEqual(latestUsage(), { input_tokens: null, output_tokens: null, total_tokens: null });
  assert.equal(latestMetrics().cached, null);
});
