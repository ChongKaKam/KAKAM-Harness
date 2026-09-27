import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { hashPassword } from '../src/kernel/crypto';

test('email identity is normalized, unique, editable with credentials, and migrates legacy accounts without losing ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drift-email-'));
  const { app, kernel } = await createApp({
    dataDir: directory,
    secret: 'email-test-secret-at-least-thirty-two-characters',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, body: unknown, cookie?: string, method = 'POST') =>
    fetch(origin + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  try {
    const registered = await request('/auth/register', {
      email: '  OWNER@Example.Test  ',
      displayName: 'Owner',
      password: '1',
    });
    assert.equal(registered.status, 201);
    const owner = (await registered.json()).user;
    assert.equal(owner.email, 'owner@example.test');
    assert.equal(owner.role, 'admin');
    assert.equal(owner.username, undefined);
    const cookie = registered.headers.get('set-cookie')!.split(';')[0];
    assert.equal(
      (
        await request('/auth/register', {
          email: 'owner@EXAMPLE.TEST',
          displayName: 'Duplicate',
          password: '2',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request('/auth/register', {
          email: 'not-an-email',
          displayName: 'Invalid',
          password: '2',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          '/admin/users',
          { email: 'OWNER@example.test', displayName: 'Duplicate', password: '2', role: 'user' },
          cookie,
        )
      ).status,
      409,
    );
    const otherSession = await request('/auth/login', {
      email: 'OWNER@example.test',
      password: '1',
    });
    assert.equal(otherSession.status, 200);
    const otherCookie = otherSession.headers.get('set-cookie')!.split(';')[0];
    assert.equal(
      (
        await request(
          '/auth/me',
          { email: 'changed@example.test', displayName: 'Owner' },
          cookie,
          'PATCH',
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          '/auth/me',
          { email: ' Changed@Example.Test ', displayName: 'Owner', currentPassword: '1' },
          cookie,
          'PATCH',
        )
      ).status,
      200,
    );
    assert.equal(
      (await fetch(origin + '/api/models', { headers: { cookie: otherCookie } })).status,
      401,
    );
    assert.equal(
      (await request('/auth/login', { email: 'owner@example.test', password: '1' })).status,
      401,
    );
    assert.equal(
      (await request('/auth/login', { email: 'changed@example.test', password: '1' })).status,
      200,
    );
    kernel.ctx.db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('legacy','old-name','Existing',?,'user')",
      await hashPassword('old-password'),
    );
    kernel.ctx.db.run(
      "INSERT INTO conversations(id,user_id,title,updated_at) VALUES('legacy-chat','legacy','Keep my chat',?)",
      new Date().toISOString(),
    );
    assert.equal(
      (
        await request('/auth/migrate-email', {
          legacyUsername: 'old-name',
          email: 'legacy@example.test',
          password: 'wrong',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request('/auth/migrate-email', {
          legacyUsername: 'old-name',
          email: 'changed@example.test',
          password: 'old-password',
        })
      ).status,
      409,
    );
    const migrated = await request('/auth/migrate-email', {
      legacyUsername: 'old-name',
      email: 'Legacy@Example.Test',
      password: 'old-password',
    });
    assert.equal(migrated.status, 200);
    assert.deepEqual((await migrated.json()).user, {
      id: 'legacy',
      email: 'legacy@example.test',
      displayName: 'Existing',
      avatar: null,
      role: 'user',
      active: true,
    });
    assert.equal(
      (
        await request('/auth/migrate-email', {
          legacyUsername: 'old-name',
          email: 'second@example.test',
          password: 'old-password',
        })
      ).status,
      401,
    );
    assert.equal(
      (await request('/auth/login', { email: 'legacy@example.test', password: 'old-password' }))
        .status,
      200,
    );
    assert.equal(
      kernel.ctx.db.get<{ user_id: string }>(
        "SELECT user_id FROM conversations WHERE id='legacy-chat'",
      )!.user_id,
      'legacy',
    );
  } finally {
    server.close();
    server.closeIdleConnections();
    await kernel.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
