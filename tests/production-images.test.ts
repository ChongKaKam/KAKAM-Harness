import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import { ImageGenerationError } from '../src/adapters/images';
import { KHKernel } from '../src/kernel';
import { modelsFeature, manifest } from '../src/features/models/server';
import type { User } from '../src/shared/types';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
let server: ReturnType<typeof createServer>;
let baseUrl: string;
const requests: Array<Record<string, unknown>> = [];
before(async () => {
  server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"data":[{"id":"image"}]}');
      return;
    }
    assert.equal(req.url, '/v1/images/generations', 'never fetch returned image URLs');
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (body.model === 'oversized') {
      res.end(JSON.stringify({ data: [{ b64_json: 'A'.repeat(29 * 1024 * 1024) }] }));
      return;
    }
    if (body.model === 'slow') {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 80));
      if (res.destroyed) return;
    }
    if (body.model === 'http-error') res.statusCode = 429;
    const data =
      body.model === 'url-only'
        ? [{ url: 'http://127.0.0.1:1/private-image' }]
        : [
            {
              b64_json:
                body.model === 'invalid-image'
                  ? Buffer.from('not a raster image').toString('base64')
                  : png.toString('base64'),
            },
          ];
    res.end(
      JSON.stringify({
        data,
        ...(body.model === 'unreported' ? {} : { usage: { input_tokens: 11, total_tokens: 11 } }),
      }),
    );
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
after(async () => {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    server.closeIdleConnections();
  });
});

test('native Images honors GPT Image / DALL-E request formats and partial real usage', async () => {
  for (const apiMode of ['chat-completions', 'responses'] as const) {
    const adapter = new OpenAICompatibleAdapter();
    const image = await adapter.generateImage(
      { baseUrl, apiKey: 'fixture', apiMode },
      'gpt-image-1',
      'A small white square',
      AbortSignal.timeout(2000),
    );
    assert.deepEqual(image.data, png);
    assert.equal(image.mimeType, 'image/png');
    assert.deepEqual(image.usage, { input: 11, output: null, total: 11 });
    const sent = requests.at(-1)!;
    assert.equal(sent.n, 1);
    assert.equal(sent.output_format, 'png');
    assert.ok(!('response_format' in sent));
    await adapter.generateImage(
      { baseUrl, apiKey: '', apiMode },
      'dall-e-3',
      'A small square',
      AbortSignal.timeout(2000),
    );
    assert.equal(requests.at(-1)!.response_format, 'b64_json');
  }
});

test('image failures preserve reported usage, forbid URL fetching and bound response memory', async () => {
  const adapter = new OpenAICompatibleAdapter();
  for (const model of ['http-error', 'invalid-image', 'url-only']) {
    await assert.rejects(
      adapter.generateImage({ baseUrl, apiKey: '' }, model, 'Square', AbortSignal.timeout(2000)),
      (error: unknown) => {
        assert.ok(error instanceof ImageGenerationError);
        assert.deepEqual(error.usage, { input: 11, output: null, total: 11 });
        return true;
      },
    );
  }
  await assert.rejects(
    adapter.generateImage(
      { baseUrl, apiKey: '' },
      'oversized',
      'Square',
      AbortSignal.timeout(5000),
    ),
    /超过/,
  );
  const unreported = await adapter.generateImage(
    { baseUrl, apiKey: '' },
    'unreported',
    'Square',
    AbortSignal.timeout(2000),
  );
  assert.equal(unreported.usage, null);
  const count = requests.length;
  await assert.rejects(
    adapter.generateImage(
      { baseUrl, apiKey: '', apiMode: 'anthropic-messages' },
      'image',
      'Square',
      AbortSignal.timeout(2000),
    ),
    /仅支持/,
  );
  assert.equal(requests.length, count);
});

test('managed Images rechecks authorization and records nullable usage on success, error and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kh-image-model-'));
  const kernel = new KHKernel(directory);
  try {
    await kernel.register(
      manifest,
      modelsFeature('production-images-fixture-secret-32-characters'),
    );
    await kernel.ctx.start();
    const admin: User = {
      id: randomUUID(),
      email: 'image-admin@example.test',
      displayName: 'Admin',
      avatar: null,
      role: 'admin',
      active: true,
    };
    const user: User = {
      ...admin,
      id: randomUUID(),
      email: 'image-user@example.test',
      role: 'user',
    };
    for (const account of [admin, user])
      kernel.ctx.db.run(
        'INSERT INTO users(id,username,email,display_name,password_hash,role) VALUES(?,?,?,?,?,?)',
        account.id,
        account.email!,
        account.email!,
        account.displayName,
        'fixture',
        account.role,
      );
    const providerId = randomUUID();
    kernel.ctx.db.run(
      'INSERT INTO providers(id,name,base_url,encrypted_key,api_mode) VALUES(?,?,?,?,?)',
      providerId,
      'Images fixture',
      baseUrl,
      kernel.ctx.models.encrypt('fixture'),
      'responses',
    );
    const modelId = randomUUID();
    kernel.ctx.db.run(
      "INSERT INTO models(id,provider_id,name,label,kind) VALUES(?,?,?,?,'image')",
      modelId,
      providerId,
      'image',
      'Images',
    );
    const count = requests.length;
    await assert.rejects(
      kernel.ctx.models.generateImage(user, modelId, 'Square', AbortSignal.timeout(2000)),
      /未启用或未向你授权/,
    );
    assert.equal(requests.length, count);
    assert.equal(kernel.ctx.db.all('SELECT * FROM usage').length, 0);
    kernel.ctx.db.run('INSERT INTO model_grants VALUES(?,?)', modelId, user.id);
    await kernel.ctx.models.generateImage(user, modelId, 'Square', AbortSignal.timeout(2000));
    let usage = kernel.ctx.db.get<{
      input_tokens: number | null;
      output_tokens: number | null;
      total_tokens: number | null;
      status: string;
    }>('SELECT * FROM usage ORDER BY rowid DESC LIMIT 1')!;
    assert.deepEqual(
      [usage.input_tokens, usage.output_tokens, usage.total_tokens, usage.status],
      [11, null, 11, 'complete'],
    );
    kernel.ctx.db.run("UPDATE models SET name='invalid-image' WHERE id=?", modelId);
    await assert.rejects(
      kernel.ctx.models.generateImage(user, modelId, 'Square', AbortSignal.timeout(2000)),
      /无效/,
    );
    usage = kernel.ctx.db.get('SELECT * FROM usage ORDER BY rowid DESC LIMIT 1')!;
    assert.deepEqual(
      [usage.input_tokens, usage.output_tokens, usage.total_tokens, usage.status],
      [11, null, 11, 'error'],
    );
    kernel.ctx.db.run("UPDATE models SET name='unreported' WHERE id=?", modelId);
    await kernel.ctx.models.generateImage(user, modelId, 'Square', AbortSignal.timeout(2000));
    usage = kernel.ctx.db.get('SELECT * FROM usage ORDER BY rowid DESC LIMIT 1')!;
    assert.deepEqual(
      [usage.input_tokens, usage.output_tokens, usage.total_tokens, usage.status],
      [null, null, null, 'complete'],
    );
    kernel.ctx.db.run("UPDATE models SET name='slow' WHERE id=?", modelId);
    await assert.rejects(
      kernel.ctx.models.generateImage(user, modelId, 'Square', AbortSignal.timeout(10)),
    );
    usage = kernel.ctx.db.get('SELECT * FROM usage ORDER BY rowid DESC LIMIT 1')!;
    assert.deepEqual(
      [usage.input_tokens, usage.output_tokens, usage.total_tokens, usage.status],
      [null, null, null, 'cancelled'],
    );
    kernel.ctx.db.run('DELETE FROM model_grants WHERE model_id=?', modelId);
    const revokedCount = requests.length;
    await assert.rejects(
      kernel.ctx.models.generateImage(user, modelId, 'Square', AbortSignal.timeout(2000)),
      /未启用或未向你授权/,
    );
    assert.equal(requests.length, revokedCount);
    kernel.ctx.db.run('UPDATE models SET enabled=0 WHERE id=?', modelId);
    await assert.rejects(
      kernel.ctx.models.generateImage(admin, modelId, 'Square', AbortSignal.timeout(2000)),
      /未启用或未向你授权/,
    );
  } finally {
    await kernel.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
