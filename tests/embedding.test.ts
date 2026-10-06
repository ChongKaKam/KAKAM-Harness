import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { KHKernel } from '../src/kernel';
import { modelsFeature, manifest } from '../src/features/models/server';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import { AnthropicMessagesAdapter } from '../src/adapters/anthropic-messages';
import { testEmbeddingConnection } from '../src/features/models/connection-test';
import { EmbeddingError } from '../src/adapters/embeddings';
import { HttpError } from '../src/kernel/http';
import type { User } from '../src/shared/types';

let provider: ReturnType<typeof createServer>;
let providerUrl: string;
const requests: Record<string, unknown>[] = [];
before(async () => {
  provider = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'embedding' }, { id: 'chat' }] }));
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    assert.equal(req.url, '/v1/embeddings');
    assert.equal(body.encoding_format, 'float');
    const size = body.model === 'dimension-mismatch' ? 3 : (body.dimensions ?? 3);
    let data = body.input
      .map((_: string, index: number) => ({
        index,
        embedding: Array.from({ length: size }, (_unused, i) => i + 1),
      }))
      .reverse();
    if (body.model === 'duplicate') data = data.map((item: object) => ({ ...item, index: 0 }));
    if (body.model === 'missing') data.pop();
    if (body.model === 'zero') data[0].embedding.fill(0);
    if (body.model === 'invalid') data[0].embedding[0] = null;
    if (body.model === 'mixed') data[0].embedding.pop();
    res.writeHead(body.model === 'http-error' ? 429 : 200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data,
        ...(body.model === 'unreported' ? {} : { usage: { prompt_tokens: 7, total_tokens: 7 } }),
      }),
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;
});
after(async () => {
  await new Promise<void>((resolve) => {
    provider.close(() => resolve());
    provider.closeIdleConnections();
  });
});

test('compatible Embedding handles both source modes, reordered indexes and partial usage', async () => {
  for (const apiMode of ['chat-completions', 'responses'] as const) {
    const result = await new OpenAICompatibleAdapter().embed(
      { baseUrl: providerUrl, apiKey: 'fixture', apiMode },
      'embedding',
      ['a', 'b'],
      AbortSignal.timeout(2000),
      2,
    );
    assert.deepEqual(result.vectors, [
      [1, 2],
      [1, 2],
    ]);
    assert.equal(result.dimensions, 2);
    assert.deepEqual(result.usage, { input: 7, output: null, total: 7 });
  }
});

test('malformed vectors and upstream HTTP errors retain reported usage', async () => {
  for (const model of ['duplicate', 'missing', 'zero', 'invalid', 'mixed', 'http-error']) {
    await assert.rejects(
      new OpenAICompatibleAdapter().embed(
        { baseUrl: providerUrl, apiKey: '' },
        model,
        ['a', 'b'],
        AbortSignal.timeout(2000),
      ),
      (error: unknown) => {
        assert.ok(error instanceof EmbeddingError, model);
        assert.equal(error.usage?.input, 7);
        assert.equal(error.usage?.output, null);
        return true;
      },
    );
  }
});

test('Embedding diagnosis exposes configured and actual dimensions, mismatch, usage and redacted diagnostics', async () => {
  const result = await testEmbeddingConnection(
    new OpenAICompatibleAdapter(),
    { baseUrl: providerUrl, apiKey: 'private-embedding-key', apiMode: 'responses' },
    'dimension-mismatch',
    2,
  );
  assert.equal(result.ok, false);
  assert.equal(result.configuredDimensions, 2);
  assert.equal(result.actualDimensions, 3);
  assert.equal(result.dimensionsMatch, false);
  assert.equal(result.usage?.total, 7);
  assert.ok(result.latencyMs >= 0);
  assert.match(result.diagnostics.request!.url, /\/embeddings$/);
  assert.ok(!JSON.stringify(result).includes('private-embedding-key'));
  const unsupported = await testEmbeddingConnection(
    new AnthropicMessagesAdapter(),
    { baseUrl: providerUrl, apiKey: '', apiMode: 'anthropic-messages' },
    'embedding',
    null,
  );
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.diagnostics.request, undefined);
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kh-embedding-'));
  const kernel = new KHKernel(dir);
  await kernel.register(manifest, modelsFeature('embedding-fixture-secret-at-least-32-characters'));
  await kernel.ctx.start();
  const admin: User = {
    id: randomUUID(),
    email: 'admin@example.test',
    displayName: 'Admin',
    role: 'admin',
    avatar: null,
    active: true,
  };
  const user: User = {
    ...admin,
    id: randomUUID(),
    email: 'user@example.test',
    displayName: 'User',
    role: 'user',
  };
  for (const account of [admin, user])
    kernel.ctx.db.run(
      'INSERT INTO users(id,username,email,display_name,password_hash,role) VALUES(?,?,?,?,?,?)',
      account.id,
      account.email!,
      account.email!,
      account.displayName,
      'fixture-unused',
      account.role,
    );
  const providerId = randomUUID();
  kernel.ctx.db.run(
    'INSERT INTO providers(id,name,base_url,encrypted_key,api_mode) VALUES(?,?,?,?,?)',
    providerId,
    'Fixture',
    providerUrl,
    kernel.ctx.models.encrypt('fixture'),
    'chat-completions',
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = admin;
    next();
  });
  app.use(kernel.ctx.http.handle);
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res
        .status(error instanceof HttpError ? error.status : 400)
        .json({ error: error instanceof Error ? error.message : 'error' }),
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, body?: object, method = body ? 'POST' : 'GET') =>
    fetch(url + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return {
    kernel,
    admin,
    user,
    providerId,
    request,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      await kernel.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('model-level type coexists at one supplier, stays out of chat and diagnoses saved dimensions', async () => {
  const f = await fixture();
  try {
    const create = await f.request('/admin/models', {
      providerId: f.providerId,
      name: 'embedding',
      label: 'Vector',
      kind: 'embedding',
      embeddingDimensions: 2,
      vision: true,
      toolCalling: true,
    });
    assert.equal(create.status, 201);
    const { id } = await create.json();
    assert.equal(
      (await f.request('/admin/models', { providerId: f.providerId, name: 'chat', label: 'Chat' }))
        .status,
      201,
    );
    assert.equal((await (await f.request('/models')).json()).length, 1);
    const embeddings = await (await f.request('/models?kind=embedding')).json();
    assert.equal(embeddings[0].kind, 'embedding');
    assert.equal(embeddings[0].vision, false);
    assert.equal(embeddings[0].toolCalling, false);
    const tested = await (await f.request(`/admin/models/${id}/test`, {})).json();
    assert.equal(tested.ok, true);
    assert.equal(tested.actualDimensions, 2);
    assert.equal(f.kernel.ctx.models.authorize(f.admin, id, 'embedding').validatedDimensions, 2);
    assert.equal(
      (
        await f.request(
          `/admin/models/${id}`,
          {
            enabled: true,
            vision: false,
            label: 'Vector',
            kind: 'embedding',
            embeddingDimensions: 3,
            userIds: [],
          },
          'PATCH',
        )
      ).status,
      200,
    );
    assert.equal(f.kernel.ctx.models.authorize(f.admin, id).validatedDimensions, null);
    assert.equal(
      (
        await f.request(
          `/admin/providers/${f.providerId}`,
          { name: 'Fixture', baseUrl: providerUrl, apiMode: 'anthropic-messages' },
          'PATCH',
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test('managed embed checks each call authorization, dimensions and real nullable usage including failures', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    f.kernel.ctx.db.run(
      "INSERT INTO models(id,provider_id,name,label,kind,embedding_dimensions) VALUES(?,?,?,?,'embedding',2)",
      id,
      f.providerId,
      'embedding',
      'Embedding',
    );
    await assert.rejects(
      f.kernel.ctx.models.embed(f.user, id, ['text'], AbortSignal.timeout(2000)),
      /未启用或未向你授权/,
    );
    f.kernel.ctx.db.run('INSERT INTO model_grants VALUES(?,?)', id, f.user.id);
    const result = await f.kernel.ctx.models.embed(
      f.user,
      id,
      ['text'],
      AbortSignal.timeout(2000),
      { purpose: 'memory' },
    );
    assert.equal(result.dimensions, 2);
    const usage = f.kernel.ctx.db.get<{
      input_tokens: number;
      output_tokens: null;
      total_tokens: number;
    }>('SELECT * FROM usage WHERE user_id=?', f.user.id)!;
    assert.equal(usage.input_tokens, 7);
    assert.equal(usage.output_tokens, null);
    assert.equal(usage.total_tokens, 7);
    await assert.rejects(
      f.kernel.ctx.models.embed(f.user, id, ['text'], AbortSignal.timeout(2000), {
        expectedDimensions: 3,
      }),
      /实际维度/,
    );
    const rows = f.kernel.ctx.db.all<{ status: string; output_tokens: null }>(
      'SELECT * FROM usage WHERE user_id=? ORDER BY created_at',
      f.user.id,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[1].status, 'error');
    assert.equal(rows[1].output_tokens, null);
    f.kernel.ctx.db.run('DELETE FROM model_grants WHERE model_id=? AND user_id=?', id, f.user.id);
    const count = requests.length;
    await assert.rejects(
      f.kernel.ctx.models.embed(f.user, id, ['text'], AbortSignal.timeout(2000)),
      /未启用或未向你授权/,
    );
    assert.equal(requests.length, count);
    f.kernel.ctx.db.run("UPDATE models SET name='unreported' WHERE id=?", id);
    await f.kernel.ctx.models.embed(f.admin, id, ['text'], AbortSignal.timeout(2000));
    assert.deepEqual(
      {
        ...f.kernel.ctx.db.get<{
          input_tokens: number | null;
          output_tokens: number | null;
          total_tokens: number | null;
        }>('SELECT input_tokens,output_tokens,total_tokens FROM usage WHERE user_id=?', f.admin.id),
      },
      { input_tokens: null, output_tokens: null, total_tokens: null },
    );
    await assert.rejects(
      f.kernel.ctx.models.embed(f.admin, id, ['  '], AbortSignal.timeout(2000)),
      /不能为空/,
    );
  } finally {
    await f.close();
  }
});

test('legacy model kind migration preserves Jev and LLM identity across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-embedding-migration-'));
  const previous = new DatabaseSync(join(dir, 'kakam.sqlite'));
  previous.exec(`
    CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,base_url TEXT NOT NULL,encrypted_key TEXT NOT NULL,api_mode TEXT NOT NULL);
    CREATE TABLE models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id),name TEXT NOT NULL,label TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,vision INTEGER NOT NULL DEFAULT 0);
    INSERT INTO providers VALUES('llm-provider','LLM','https://example.test/v1','unused','responses'),('jev-provider','Jev','https://example.test/jev','unused','jev');
    INSERT INTO models VALUES('llm-model','llm-provider','chat','Chat',1,0),('jev-model','jev-provider','decision','Decision',1,0);
  `);
  previous.close();
  try {
    for (let restart = 0; restart < 2; restart++) {
      const kernel = new KHKernel(dir);
      assert.equal(
        kernel.ctx.db.get<{ kind: string }>('SELECT kind FROM models WHERE id=?', 'llm-model')
          ?.kind,
        'llm',
      );
      assert.equal(
        kernel.ctx.db.get<{ kind: string }>('SELECT kind FROM models WHERE id=?', 'jev-model')
          ?.kind,
        'jev',
      );
      assert.equal(
        kernel.ctx.db
          .all<{ name: string }>('PRAGMA table_info(models)')
          .filter((column) => column.name === 'embedding_dimensions').length,
        1,
      );
      await kernel.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
