import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/server/app';
import type { GatewayDashboard } from '../src/features/openai-gateway/dashboard-types';

const dashboard = '/api/admin/openai-gateway/dashboard';
let app: Awaited<ReturnType<typeof createApp>>;
let server: ReturnType<typeof app.app.listen>;
let directory: string, origin: string;
let owner: Awaited<ReturnType<typeof register>>;
let secondAdmin: Awaited<ReturnType<typeof register>>;
let member: Awaited<ReturnType<typeof register>>;

async function register(name: string) {
  const response = await fetch(origin + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: name + '@example.test', displayName: name, password: 'fixture' }),
  });
  assert.equal(response.status, 201);
  return {
    id: (await response.json()).user.id as string,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
}

function get(cookie: string, query = '') {
  return fetch(origin + dashboard + query, { headers: { cookie } });
}

async function read(cookie: string, query = '') {
  const response = await get(cookie, query);
  assert.equal(response.status, 200);
  return (await response.json()) as GatewayDashboard;
}

function utcMidnight(daysAgo: number) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString();
}

function usage(
  user: string,
  daysAgo: number,
  status: string,
  tokens: [number | null, number | null, number | null],
  metrics?: { cached: number | null; duration: number },
  model = '[OpenAI Gateway] test-model',
) {
  const id = randomUUID();
  app.kernel.ctx.db.run(
    'INSERT INTO usage(id,user_id,model_name,input_tokens,output_tokens,total_tokens,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id,
    user,
    model,
    ...tokens,
    status,
    utcMidnight(daysAgo),
  );
  if (metrics)
    app.kernel.ctx.db.run(
      'INSERT INTO openai_gateway_metrics(usage_id,cached_input_tokens,duration_ms) VALUES(?,?,?)',
      id,
      metrics.cached,
      metrics.duration,
    );
}

async function start() {
  app = await createApp({
    dataDir: directory,
    secret: 'dashboard-fixture-secret-at-least-32-characters',
    host: '127.0.0.1',
    port: 0,
    secureCookies: false,
    trustProxy: 0,
  });
  server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
}

async function stop() {
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  if (app) await app.kernel.stop();
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'drift-gateway-dashboard-'));
  await start();
  owner = await register('owner');
  secondAdmin = await register('second');
  member = await register('member');
  app.kernel.ctx.db.run("UPDATE users SET role='admin' WHERE id=?", secondAdmin.id);
  // Reproduce the pre-dashboard schema, then upgrade with its original usage rows.
  app.kernel.ctx.db.run('DROP TABLE openai_gateway_metrics');
  usage(owner.id, 2, 'error', [8, 2, 10]);
  usage(owner.id, 6, 'complete', [50, null, null]); // Last included UTC day.
  usage(owner.id, 7, 'complete', [5000, 0, 5000]); // First excluded UTC day.
  usage(owner.id, 1, 'complete', [32, 0, 32], undefined, 'ordinary-chat');
  await stop();
  await start();

  usage(owner.id, 1, 'complete', [900, 100, 1000], { cached: 720, duration: 1500 });
  usage(owner.id, 2, 'complete', [100, 10, 110], { cached: 0, duration: 2500 });
  usage(owner.id, 2, 'cancelled', [null, null, null], { cached: null, duration: 6500 });
  // A post-upgrade non-gateway model with this prefix must stay outside the dashboard across restarts.
  usage(owner.id, 1, 'complete', [300, 30, 330], undefined, '[OpenAI Gateway] chat model label');
  await stop();
  await start();
});

after(async () => {
  await stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('dashboard weights cache hits by input tokens and counts cancelled and legacy calls', async () => {
  const { totals, daily, days } = await read(owner.cookie);
  assert.equal(days, 7);
  assert.deepEqual(totals, {
    calls: 5,
    succeeded: 3,
    failed: 1,
    cancelled: 1,
    successRate: 60,
    inputTokens: 1058,
    outputTokens: 112,
    totalTokens: 1120,
    tokenSamples: 3,
    cachedInputTokens: 720,
    cacheSampleInputTokens: 1000,
    cacheSamples: 2,
    cacheHitRate: 72,
    averageDurationMs: 2000,
    durationSamples: 2,
  });
  assert.deepEqual(
    daily.map((row) => row.day),
    Array.from({ length: 7 }, (_, i) => utcMidnight(6 - i).slice(0, 10)),
  );
  assert.equal(
    daily.reduce((sum, day) => sum + day.calls, 0),
    totals.calls,
  );
  assert.equal(daily[0].cacheHitRate, null);
  assert.equal(daily[0].averageDurationMs, null);
  assert.equal(daily[4].cacheHitRate, 0);
  assert.equal(daily[5].cacheHitRate, 80);
  const month = await read(owner.cookie, '?days=30');
  assert.equal(month.totals.calls, 6);
  assert.equal(month.totals.totalTokens, 6120);
  assert.equal(month.totals.cacheHitRate, 72);
});

test('dashboard only exposes calls for the current administrator and validates the period', async () => {
  assert.equal((await get('')).status, 401);
  assert.equal((await get(member.cookie)).status, 403);
  assert.equal((await get(owner.cookie, '?days=10')).status, 400);
  assert.equal((await get(secondAdmin.cookie, '?userId=' + owner.id)).status, 400);
  const { totals } = await read(secondAdmin.cookie);
  assert.equal(totals.calls, 0);
  assert.equal(totals.totalTokens, null);
  assert.equal(totals.successRate, null);
  assert.equal(totals.cacheHitRate, null);
  assert.equal(totals.averageDurationMs, null);
});
