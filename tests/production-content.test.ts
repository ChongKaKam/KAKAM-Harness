import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import type { User } from '../src/shared/types';

let app: Awaited<ReturnType<typeof createApp>>;
let server: ReturnType<typeof createServer>;
let directory: string;
let origin: string;
let owner: { cookie: string; user: User };
let admin: { cookie: string; user: User };
let other: { cookie: string; user: User };
let conversationId: string;

async function register(name: string) {
  const response = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.test`, displayName: name, password: 'x' }),
  });
  assert.equal(response.status, 201);
  return {
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    user: (await response.json()).user as User,
  };
}

function create(name: string, mimeType: string, data: Uint8Array) {
  return app.kernel.ctx.production.create(owner.user, { conversationId, name, mimeType, data });
}

function content(id: string, cookie = owner.cookie) {
  return fetch(`${origin}/api/llm-production/artifacts/${id}/content`, {
    headers: cookie ? { cookie } : {},
  });
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-production-content-'));
  app = await createApp({
    secret: 'production-content-test-secret-at-least-32-characters',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
    dataDir: directory,
  });
  server = createServer(app.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  admin = await register('content-admin');
  owner = await register('content-owner');
  other = await register('content-other');
  const response = await fetch(`${origin}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: owner.cookie },
    body: '{}',
  });
  assert.equal(response.status, 201);
  conversationId = (await response.json()).id;
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

test('content remains private, bounded by owner and denied immediately after expiry or deletion', async () => {
  const bytes = Buffer.from('私有产物\nDrift Space');
  const file = create('private.txt', 'text/plain', bytes);
  const response = await content(file.id);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('content-disposition'), 'inline');
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'none'; sandbox; frame-ancestors 'none'",
  );
  assert.equal((await content(file.id, '')).status, 401);
  for (const cookie of [admin.cookie, other.cookie]) {
    const inaccessible = await content(file.id, cookie);
    assert.equal(inaccessible.status, 404);
    assert.equal(inaccessible.headers.get('cache-control'), 'private, no-store');
  }
  app.kernel.ctx.db.run(
    'UPDATE production_artifacts SET expires_at=? WHERE id=?',
    new Date(Date.now() - 1).toISOString(),
    file.id,
  );
  assert.equal((await content(file.id)).status, 404);
  const deleted = create('deleted.txt', 'text/plain', bytes);
  app.kernel.ctx.production.remove(owner.user.id, deleted.id);
  assert.equal((await content(deleted.id)).status, 404);
});

test('content only serves signature-checked raster images and PDF with their original media type', async () => {
  const samples = [
    {
      name: 'image.png',
      mime: 'image/png',
      data: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
      ),
    },
    { name: 'image.jpg', mime: 'image/jpeg', data: Buffer.from([255, 216, 255, 224]) },
    { name: 'image.webp', mime: 'image/webp', data: Buffer.from('RIFF\x04\x00\x00\x00WEBP') },
    { name: 'report.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.7\n%%EOF') },
  ];
  for (const sample of samples) {
    const file = create(sample.name, sample.mime, sample.data);
    const response = await content(file.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), sample.mime);
    assert.equal(response.headers.get('content-disposition'), 'inline');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), sample.data);
  }
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'application/pdf']) {
    const file = create('spoofed.bin', mime, Buffer.from('<script>window.pwned = true</script>'));
    const response = await content(file.id);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.ok(response.headers.get('content-disposition')?.startsWith('attachment;'));
  }
  const mismatch = create('wrong.png', 'image/png', samples[1].data);
  assert.equal(
    (await content(mismatch.id)).headers.get('content-type'),
    'application/octet-stream',
  );
});

test('active documents are returned as inert text and unsupported binary stays a download', async () => {
  const source = Buffer.from('<script>window.pwned = true</script>\n<svg onload="alert(1)"/>');
  for (const mime of [
    'text/html',
    'image/svg+xml',
    'application/xhtml+xml',
    'application/xml',
    'text/javascript',
    'text/markdown',
    'text/csv',
    'application/json',
  ]) {
    const file = create('source.txt', mime, source);
    const response = await content(file.id);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), source);
  }
  const office = create(
    'workbook.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    Buffer.from('PK\x03\x04binary'),
  );
  const response = await content(office.id);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.ok(response.headers.get('content-disposition')?.startsWith('attachment;'));
});
