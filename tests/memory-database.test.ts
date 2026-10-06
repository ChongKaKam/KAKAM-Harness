import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { readMemoryConfig } from '../src/kernel/memory-config';
import { MemoryDatabase, memoryTables } from '../src/kernel/memory-database';
import { PgMemoryRepository } from '../src/features/memory/repository';
import { memoryInputSchema } from '../src/features/memory/config';
import { createApp } from '../src/server/app';

const adminUrl = process.env.MEMORY_TEST_DATABASE_URL;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `memory_test_${suffix}`,
  schema = `memory_test_${suffix}`;
const fixturePassword = randomUUID();
let admin: Pool, database: MemoryDatabase, appUrl: string;
const enabled = { skip: !adminUrl };

test('Memory config validates Monitor metadata, pool limits and schema without exposing credentials', () => {
  const env = {
    MEMORY_DATABASE_URL: 'postgresql://app:fixture-secret@kakamlab-db:5656/memory_test',
    MEMORY_DB_HOST: 'kakamlab-db',
    MEMORY_DB_PORT: '5656',
    MEMORY_DB_NAME: 'memory_test',
    MEMORY_DB_USER: 'app',
    MEMORY_DB_SCHEMA: 'memory_test',
  };
  assert.equal(readMemoryConfig(env).databaseOptions.poolMax, 5);
  assert.throws(
    () => readMemoryConfig({ ...env, MEMORY_DB_USER: 'different' }),
    (error: Error) => {
      assert.doesNotMatch(error.message, /fixture-secret|postgresql:\/\//);
      return true;
    },
  );
  assert.throws(() => readMemoryConfig({ ...env, MEMORY_DB_POOL_MAX: '17' }));
  assert.throws(() => readMemoryConfig({ ...env, MEMORY_DB_SCHEMA: 'public;DROP' }));
  assert.throws(() => readMemoryConfig({ MEMORY_DB_HOST: 'kakamlab-db' }));
  assert.throws(() => readMemoryConfig({ MEMORY_DATABASE_URL: 'not-a-url' }));
  assert.throws(() =>
    readMemoryConfig({ ...env, MEMORY_DATABASE_URL: `${env.MEMORY_DATABASE_URL}?host=other` }),
  );
});

test('Memory readiness reports missing or failed configuration while platform liveness remains available', async () => {
  for (const memoryDatabaseUrl of [
    undefined,
    'postgresql://fixture:private-test-password@127.0.0.1:1/memory_test',
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'memory-health-test-'));
    const app = await createApp({
      dataDir: directory,
      secret: 'fixture-secret-at-least-32-characters',
      host: '127.0.0.1',
      port: 0,
      secureCookies: false,
      trustProxy: 0,
      memoryDatabaseUrl,
    });
    const server = createServer(app.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      const health = await fetch(`${base}/api/health/memory`),
        body = await health.json();
      assert.equal(health.status, memoryDatabaseUrl ? 503 : 200);
      assert.equal(body.status, memoryDatabaseUrl ? 'unavailable' : 'unconfigured');
      assert.doesNotMatch(JSON.stringify(body), /private-test-password|postgresql:\/\//);
      await app.kernel.toggle('memory', false);
      assert.equal((await (await fetch(`${base}/api/health/memory`)).json()).status, 'disabled');
    } finally {
      await app.kernel.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await rm(directory, { recursive: true, force: true });
    }
  }
});

before(async () => {
  if (!adminUrl) return;
  assert.match(
    new URL(adminUrl).pathname,
    /test/i,
    'Only use an isolated disposable test database',
  );
  admin = new Pool({ connectionString: adminUrl });
  const { database: name } = (await admin.query('SELECT current_database() AS database')).rows[0];
  await admin.query(
    `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16 PASSWORD '${fixturePassword}'`,
  );
  await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${role}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await admin.query(
    `ALTER ROLE ${role} IN DATABASE "${name.replaceAll('"', '""')}" SET search_path TO ${schema},public`,
  );
  const url = new URL(adminUrl);
  url.username = role;
  url.password = fixturePassword;
  appUrl = url.toString();
});
after(async () => {
  await database?.close();
  if (!admin) return;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`DROP OWNED BY ${role}`);
  await admin.query(`DROP ROLE ${role}`);
  await admin.end();
});

test(
  'a restricted application role migrates only its schema and performs real pgvector reads/writes',
  enabled,
  async () => {
    database = new MemoryDatabase(appUrl, { schema, poolMax: 2 });
    await database.initialized();
    assert.equal(database.ready, true, database.error ?? 'must migrate');
    const info = await database.describe();
    assert.equal(info.user, role);
    assert.equal(info.schema, schema);
    assert.equal(info.migrationVersion, 2);
    const tables = (
      await admin.query('SELECT tablename,tableowner FROM pg_tables WHERE schemaname=$1', [schema])
    ).rows;
    assert.deepEqual(new Set(tables.map((row) => row.tablename)), new Set(memoryTables));
    assert(tables.every((row) => row.tableowner === role));
    const repository = new PgMemoryRepository(database, `test-${suffix}`),
      owner = randomUUID();
    const item = await repository.create(
      owner,
      memoryInputSchema.parse({ scope: 'user', kind: 'fact', content: '共享 schema 检索验证' }),
      [],
      true,
    );
    const space = await repository.ensureSpace(owner, randomUUID(), 'test-vector', 3);
    await repository.storeVector(owner, item.id, item.version, space.id, [1, 0, 0]);
    assert.equal(
      (await repository.candidates(owner, [1, 0, 0], space.id, null, null, 10, 0.3))[0].id,
      item.id,
    );
    const check = new MemoryDatabase(appUrl, { schema, migrate: false });
    try {
      assert.equal((await check.describe()).schema, schema);
    } finally {
      await check.close();
    }
  },
);

test(
  'configured schema mismatch fails before migration and never falls back to public',
  enabled,
  async () => {
    const incorrect = new MemoryDatabase(appUrl, { schema: `${schema}_missing` });
    try {
      await incorrect.initialized();
      assert.equal(incorrect.ready, false);
      assert.match(incorrect.error!, /search_path/);
      await assert.rejects(incorrect.query('SELECT 1'), { status: 503 });
    } finally {
      await incorrect.close();
    }
  },
);

test(
  'read-only CLI check refuses an unmigrated schema without creating tables',
  enabled,
  async () => {
    const empty = `${schema}_empty`;
    await admin.query(`CREATE SCHEMA ${empty} AUTHORIZATION ${role}`);
    const url = new URL(appUrl);
    url.searchParams.set('options', `-c search_path=${empty},public`);
    try {
      const output = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'src/server/memory-db.ts', 'check'],
        {
          env: { ...process.env, MEMORY_DATABASE_URL: url.toString(), MEMORY_DB_SCHEMA: empty },
          timeout: 20000,
        },
      ).then(
        () => {
          throw new Error('check should fail');
        },
        (error) => error,
      );
      assert.equal(output.code, 1);
      assert.doesNotMatch(output.stderr, /postgresql:\/\//);
      assert.equal(
        (
          await admin.query('SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=$1', [
            empty,
          ])
        ).rows[0].count,
        0,
      );
    } finally {
      await admin.query(`DROP SCHEMA ${empty}`);
    }
  },
);

test(
  'loss of a pooled connection recovers automatically with idempotent migrations',
  enabled,
  async () => {
    const pid = (await database.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await delay(100);
    assert.equal(database.ready, false);
    for (let i = 0; i < 100 && !database.ready; i++) await delay(100);
    assert.equal((await database.health()).ready, true, database.error ?? 'must recover');
    assert.equal((await database.describe()).migrationVersion, 2);
  },
);

test(
  'missing extension remains administrator-owned and recovers after it is installed',
  enabled,
  async () => {
    const name = `memory_extension_test_${suffix}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    const isolated = new Pool({ connectionString: url.toString() });
    let missing: MemoryDatabase | undefined;
    try {
      await isolated.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${role}`);
      await isolated.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await isolated.query(
        `ALTER ROLE ${role} IN DATABASE ${name} SET search_path TO ${schema},public`,
      );
      url.username = role;
      url.password = fixturePassword;
      missing = new MemoryDatabase(url.toString(), { schema });
      await missing.initialized();
      assert.equal(missing.ready, false);
      assert.match(missing.error!, /管理员.*pgvector/);
      assert.equal(
        (
          await isolated.query(
            "SELECT count(*)::int AS count FROM pg_extension WHERE extname='vector'",
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await isolated.query('SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=$1', [
            schema,
          ])
        ).rows[0].count,
        0,
      );
      await isolated.query('CREATE EXTENSION vector WITH SCHEMA public');
      for (let i = 0; i < 100 && !missing.ready; i++) await delay(100);
      assert.equal((await missing.health()).ready, true, missing.error ?? 'must recover');
    } finally {
      await missing?.close();
      await isolated.end();
      await admin.query(`DROP DATABASE ${name}`);
    }
  },
);
