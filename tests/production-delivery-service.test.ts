import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { HttpError } from '../src/kernel/http';
import { productionMimeTypes } from '../src/features/llm-production/generators';
import type { ProductionPlanInput } from '../src/features/llm-production/delivery';
import type { ProductionFormat } from '../src/features/llm-production/types';
import type { ConversationToolScope } from '../src/features/extensions/conversation-tools';
import type { User } from '../src/shared/types';

let app: Awaited<ReturnType<typeof createApp>>;
let directory: string;
let owner: User;
let other: User;
let imageModelId: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'kh-delivery-service-'));
  app = await createApp({
    dataDir: directory,
    secret: 'delivery-service-fixture-secret-at-least-32-characters',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  const db = app.kernel.ctx.db;
  function user(name: string): User {
    const id = randomUUID();
    db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'fixture','user')",
      id,
      name,
      name,
    );
    return {
      id,
      email: `${name}@example.test`,
      displayName: name,
      avatar: null,
      role: 'user',
      active: true,
    };
  }
  owner = user('delivery-owner');
  other = user('delivery-other');
  const providerId = randomUUID();
  db.run(
    'INSERT INTO providers(id,name,base_url,encrypted_key) VALUES(?,?,?,?)',
    providerId,
    'Fixture',
    'http://127.0.0.1:1',
    app.kernel.ctx.models.encrypt(''),
  );
  imageModelId = randomUUID();
  db.run(
    "INSERT INTO models(id,provider_id,name,label,kind) VALUES(?,?,?,?,'image')",
    imageModelId,
    providerId,
    'fixture-image',
    'Fixture Image',
  );
  db.run('INSERT INTO model_grants(model_id,user_id) VALUES(?,?)', imageModelId, owner.id);
  app.kernel.ctx.production.savePreferences(owner, { imageModelId });
});
after(async () => {
  await app?.kernel.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function scope(user = owner, required = false): ConversationToolScope {
  const conversationId = randomUUID();
  const messageId = randomUUID();
  app.kernel.ctx.db.run(
    'INSERT INTO conversations(id,user_id,title,updated_at) VALUES(?,?,?,?)',
    conversationId,
    user.id,
    'Delivery fixture',
    new Date().toISOString(),
  );
  app.kernel.ctx.db.run(
    "INSERT INTO messages(id,conversation_id,role,content,created_at,production_mode) VALUES(?,?,'assistant','',?,?)",
    messageId,
    conversationId,
    new Date().toISOString(),
    required ? 'required' : 'auto',
  );
  return {
    user,
    conversationId,
    messageId,
    requestId: messageId,
    signal: new AbortController().signal,
    requireDelivery: required,
  };
}
function files(count = 2, format: ProductionFormat = 'html'): ProductionPlanInput {
  return {
    decision: 'deliver',
    question: null,
    items: Array.from({ length: count }, (_, index) => ({
      kind: 'file',
      format,
      name: `file-${index}.html`,
      brief: `File ${index}`,
    })),
  };
}
function create(
  current: ConversationToolScope,
  itemId: string | null,
  format: ProductionFormat = 'html',
  key = randomUUID(),
) {
  return app.kernel.ctx.production.create(current.user, {
    conversationId: current.conversationId,
    messageId: current.messageId,
    deliveryItemId: itemId,
    name: `fixture.${format}`,
    mimeType: productionMimeTypes[format],
    data: Buffer.from('<!doctype html><title>Fixture</title>'),
    idempotencyKey: key,
  });
}
function rejectsStatus(action: () => unknown, status: number) {
  assert.throws(action, (error) => error instanceof HttpError && error.status === status);
}

test('required mode plans first; declarations are bounded, immutable and idempotent', () => {
  const current = scope(owner, true);
  const selected = app.kernel.ctx.extensions.conversationTools(owner, '', true);
  assert.deepEqual(
    selected.toolsFor(current).map((tool) => tool.name),
    ['production_plan'],
  );
  rejectsStatus(() => create(current, null), 400);
  const input = files();
  const declared = app.kernel.ctx.production.declareDelivery(current, input);
  assert.equal(declared.items.length, 2);
  assert.notEqual(declared.items[0].id, declared.items[1].id);
  assert.deepEqual(app.kernel.ctx.production.declareDelivery(current, input), declared);
  rejectsStatus(() => app.kernel.ctx.production.declareDelivery(current, files(1)), 409);
  rejectsStatus(
    () =>
      app.kernel.ctx.production.declareDelivery(current, {
        decision: 'clarify',
        items: [],
        question: 'Change plan?',
      }),
    409,
  );
  assert.throws(() => app.kernel.ctx.production.declareDelivery(scope(), files(13)));
  assert.ok(selected.toolsFor(current).some((tool) => tool.name === 'production_create_file'));
});

test('delivery binds owner, message, item, kind and explicit format to distinct real files', () => {
  const current = scope();
  const declared = app.kernel.ctx.production.declareDelivery(current, files());
  const [first, second] = declared.items;
  rejectsStatus(
    () =>
      app.kernel.ctx.production.deliveryItem({ ...current, user: other }, first.id, 'file', 'html'),
    404,
  );
  assert.equal(app.kernel.ctx.production.delivery(other.id, current.messageId), null);
  const otherMessage = scope();
  app.kernel.ctx.production.declareDelivery(otherMessage, files());
  rejectsStatus(
    () => app.kernel.ctx.production.deliveryItem(otherMessage, first.id, 'file', 'html'),
    400,
  );
  rejectsStatus(() => create(current, null), 400);
  rejectsStatus(() => create(current, first.id, 'markdown'), 400);
  rejectsStatus(() => app.kernel.ctx.production.deliveryItem(current, first.id, 'image'), 400);
  const key = randomUUID();
  const firstFile = create(current, first.id, 'html', key);
  assert.equal(firstFile.deliveryItemId, first.id);
  assert.deepEqual(
    app.kernel.ctx.production
      .delivery(owner.id, current.messageId)!
      .items.map((item) => item.status),
    ['complete', 'pending'],
  );
  assert.equal(create(current, first.id).id, firstFile.id);
  rejectsStatus(() => create(current, second.id, 'html', key), 409);
  const secondFile = create(current, second.id);
  assert.notEqual(firstFile.id, secondFile.id);
  assert.deepEqual(
    app.kernel.ctx.production
      .delivery(owner.id, current.messageId)!
      .items.map((item) => item.status),
    ['complete', 'complete'],
  );
  app.kernel.ctx.production.remove(owner.id, firstFile.id);
  assert.deepEqual(
    app.kernel.ctx.production
      .delivery(owner.id, current.messageId)!
      .items.map((item) => item.status),
    ['pending', 'complete'],
  );
  app.kernel.ctx.db.run(
    'UPDATE production_artifacts SET expires_at=? WHERE id=?',
    new Date(Date.now() - 1).toISOString(),
    secondFile.id,
  );
  assert.deepEqual(
    app.kernel.ctx.production
      .delivery(owner.id, current.messageId)!
      .items.map((item) => item.status),
    ['pending', 'pending'],
  );
});

test('Auto single files stay direct; later plans cannot relabel files, and clarification delivers a question', () => {
  const direct = scope();
  const saved = create(direct, null);
  assert.equal(saved.deliveryItemId, null);
  assert.equal(app.kernel.ctx.production.delivery(owner.id, direct.messageId), null);
  rejectsStatus(() => app.kernel.ctx.production.declareDelivery(direct, files()), 409);
  const current = scope(owner, true);
  const plan = app.kernel.ctx.production.declareDelivery(current, {
    decision: 'clarify',
    items: [],
    question: '需要哪种格式？',
  });
  assert.equal(plan.question, '需要哪种格式？');
  assert.equal(
    app.kernel.ctx.extensions.conversationTools(owner, '', true).pending(current).length,
    0,
  );
  rejectsStatus(() => create(current, null), 409);
});

test('planned and direct failed images cannot cause a second paid call in the same reply', async () => {
  const models = app.kernel.ctx.models;
  const previous = models.generateImage;
  let paidCalls = 0;
  models.generateImage = async () => {
    paidCalls++;
    throw new HttpError(502, 'Fixture image generation failed');
  };
  try {
    for (const planned of [false, true]) {
      const current = scope(owner, planned);
      const itemId = planned
        ? app.kernel.ctx.production.declareDelivery(current, {
            decision: 'deliver',
            question: null,
            items: [{ kind: 'image', format: null, name: 'poster.png', brief: 'A poster' }],
          }).items[0].id
        : null;
      const selected = app.kernel.ctx.extensions.conversationTools(owner, '', planned);
      const argumentsInput = { itemId, name: 'poster.png', prompt: 'A poster' };
      const before = paidCalls;
      const output = await selected.execute(current, {
        id: randomUUID(),
        name: 'production_generate_image',
        arguments: argumentsInput,
      });
      assert.match(JSON.parse(output).error, /Fixture/);
      assert.equal(paidCalls, before + 1);
      assert.ok(selected.pending(current).some((requirement) => requirement.stopOnFailure));
      assert.ok(
        !selected.toolsFor(current).some((tool) => tool.name === 'production_generate_image'),
      );
      await assert.rejects(
        selected.execute(current, {
          id: randomUUID(),
          name: 'production_generate_image',
          arguments: argumentsInput,
        }),
        (error) => error instanceof HttpError && error.status === 403,
      );
      assert.equal(paidCalls, before + 1);
      if (planned) {
        const item = app.kernel.ctx.production.delivery(owner.id, current.messageId)!.items[0];
        assert.equal(item.status, 'failed');
        assert.match(item.error!, /Fixture/);
      }
    }
  } finally {
    models.generateImage = previous;
  }
});

test('completed image items return the stored file without another paid call; remaining images stay pending', async () => {
  const current = scope(owner, true);
  const plan = app.kernel.ctx.production.declareDelivery(current, {
    decision: 'deliver',
    question: null,
    items: [
      { kind: 'image', format: null, name: 'first.png', brief: 'First' },
      { kind: 'image', format: null, name: 'second.png', brief: 'Second' },
    ],
  });
  const models = app.kernel.ctx.models;
  const previous = models.generateImage;
  let paidCalls = 0;
  models.generateImage = async () => {
    paidCalls++;
    return {
      data: Buffer.from('fixture bytes'),
      mimeType: 'image/png',
      usage: { input: 1, output: 2, total: 3 },
    };
  };
  try {
    const selected = app.kernel.ctx.extensions.conversationTools(owner, '', true);
    const argumentsInput = { itemId: plan.items[0].id, name: 'first.png', prompt: 'First' };
    const first = JSON.parse(
      await selected.execute(current, {
        id: randomUUID(),
        name: 'production_generate_image',
        arguments: argumentsInput,
      }),
    );
    const repeat = JSON.parse(
      await selected.execute(current, {
        id: randomUUID(),
        name: 'production_generate_image',
        arguments: argumentsInput,
      }),
    );
    assert.equal(first.id, repeat.id);
    assert.equal(paidCalls, 1);
    assert.equal(app.kernel.ctx.production.forMessage(owner.id, current.messageId).length, 1);
    const pending = selected.pending(current);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].stopOnFailure, false);
  } finally {
    models.generateImage = previous;
  }
});

test('revoking an image grant after planning prevents generation before another paid call', async () => {
  const current = scope(owner, true);
  const plan = app.kernel.ctx.production.declareDelivery(current, {
    decision: 'deliver',
    question: null,
    items: [{ kind: 'image', format: null, name: 'poster.png', brief: 'A poster' }],
  });
  const selected = app.kernel.ctx.extensions.conversationTools(owner, '', true);
  app.kernel.ctx.db.run(
    'DELETE FROM model_grants WHERE model_id=? AND user_id=?',
    imageModelId,
    owner.id,
  );
  try {
    assert.ok(
      !selected.toolsFor(current).some((tool) => tool.name === 'production_generate_image'),
    );
    await assert.rejects(
      selected.execute(current, {
        id: randomUUID(),
        name: 'production_generate_image',
        arguments: { itemId: plan.items[0].id, name: 'poster.png', prompt: 'A poster' },
      }),
      (error) => error instanceof HttpError && error.status === 403,
    );
    assert.equal(app.kernel.ctx.production.forMessage(owner.id, current.messageId).length, 0);
    assert.equal(
      app.kernel.ctx.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM usage')!.count,
      0,
    );
  } finally {
    app.kernel.ctx.db.run(
      'INSERT INTO model_grants(model_id,user_id) VALUES(?,?)',
      imageModelId,
      owner.id,
    );
  }
});
