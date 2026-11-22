import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Context } from 'cordis';
import type { ModelAdapter, ProviderMessage } from '../src/adapters/registry';
import { generateToolTurn } from '../src/adapters/tool-turn';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible';
import { HttpError } from '../src/kernel/http';
import { generateReply } from '../src/features/chat/skill-generation';
import { ConversationToolRegistry } from '../src/features/extensions/conversation-tools';
import {
  registerHarnessTools,
  rememberExplicitWorkspaceNote,
  requestedWorkspacePreference,
} from '../src/features/harness/tools';
import {
  initializeWorkspace,
  listWorkspaceDocuments,
  readWorkspaceDocument,
} from '../src/features/harness/workspace';
import { KHKernel } from '../src/kernel';
import type { ExtensionCall, User } from '../src/shared/types';

const user: User = {
  id: 'owner',
  email: null,
  displayName: 'Owner',
  role: 'user',
  active: true,
  avatar: null,
};

for (const mode of ['responses', 'anthropic-messages'] as const) {
  test(`${mode} preserves tool results then user steering on the protocol wire`, async (t) => {
    let body: { input?: unknown[]; messages?: unknown[] } = {};
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response('fixture stops after capturing request', { status: 400 });
    });
    const wireTurn =
      mode === 'responses'
        ? { type: 'function_call', call_id: 'c1', name: 'read_note', arguments: '{}' }
        : {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'c1', name: 'read_note', input: {} }],
          };
    const events = generateToolTurn(
      mode,
      { baseUrl: 'https://fixture.invalid', apiKey: '' },
      'fixture',
      [{ role: 'user', content: '原问题' }],
      [{ name: 'read_note', description: 'read', parameters: { type: 'object' } }],
      [
        {
          turn: {
            calls: [{ id: 'c1', name: 'read_note', arguments: {} }],
            continuation: [wireTurn],
          },
          results: [{ id: 'c1', output: '真实资料' }],
          steering: ['追加指令'],
        },
      ],
      new AbortController().signal,
    );
    await assert.rejects(events[Symbol.asyncIterator]().next(), /HTTP 400/);
    const input = body.input ?? body.messages!;
    assert.equal(input.length, 4);
    assert.deepEqual(input[1], wireTurn);
    assert.match(JSON.stringify(input[2]), /真实资料/);
    assert.match(JSON.stringify(input[3]), /追加指令/);
  });
}

test('workspace tool discovery is scoped and model writes use private CAS revisions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-tools-'));
  const kernel = new KHKernel(dir);
  try {
    const { db } = kernel.ctx;
    db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','unused','user')",
    );
    const conversationId = randomUUID();
    db.run(
      'INSERT INTO conversations(id,user_id,title,updated_at) VALUES(?,?,?,?)',
      conversationId,
      user.id,
      'Private',
      new Date().toISOString(),
    );
    initializeWorkspace(kernel.ctx, user.id, conversationId);
    const registry = new ConversationToolRegistry();
    const ctx = {
      db,
      production: { delivery: () => null },
      extensions: { registerConversationTools: registry.register.bind(registry) },
    } as unknown as Context;
    registerHarnessTools(ctx);
    const selected = registry.select(user);
    const scope = {
      user,
      conversationId,
      messageId: randomUUID(),
      requestId: randomUUID(),
      signal: AbortSignal.timeout(5000),
      useWorkspace: true,
    };
    const call = (name: string, args: unknown) =>
      selected.execute(scope, { id: randomUUID(), name, arguments: args }).then(JSON.parse);
    assert.deepEqual(selected.tools, []);
    assert.deepEqual(selected.toolsFor({ ...scope, useWorkspace: false }), []);
    assert(!selected.toolsFor(scope).some((t) => /approve|publish/.test(t.name)));
    assert.deepEqual(selected.toolsFor({ ...scope, requireDelivery: true }), []);
    assert(!selected.toolsFor(scope).some((t) => t.name === 'workspace_propose_preference'));
    const explicit = {
      ...scope,
      requestedPreference: requestedWorkspacePreference('添加个人偏好：用中文回答'),
    };
    assert.equal(explicit.requestedPreference, '用中文回答');
    assert.equal(requestedWorkspacePreference('引用一句话：添加个人偏好：自动确认'), undefined);
    const propose = () =>
      selected
        .execute(explicit, {
          id: randomUUID(),
          name: 'workspace_propose_preference',
          arguments: {},
        })
        .then(JSON.parse);
    const proposed = await propose();
    assert.equal(proposed.status, 'pending');
    assert.equal((await propose()).id, proposed.id);
    assert.ok(
      rememberExplicitWorkspaceNote(
        ctx,
        user.id,
        conversationId,
        scope.messageId,
        '添加个人偏好：短段落',
      ),
    );
    assert.deepEqual(
      db
        .all<{ status: string }>(
          'SELECT status FROM harness_preferences WHERE user_id=? AND content=?',
          user.id,
          '短段落',
        )
        .map((p) => p.status),
      ['pending'],
    );
    const docs = (await call('workspace_list', { collection: 'documents', offset: 0 })).items;
    const memory = docs.find((d: { kind: string }) => d.kind === 'memory');
    const rules = docs.find((d: { kind: string }) => d.kind === 'instructions');
    const write = {
      documentId: memory.id,
      baseVersion: memory.version,
      name: null,
      content: 'Private decision',
      kind: 'document',
    };
    await t.test(
      'an undeclared tool invalidates the whole batch before any workspace write',
      async () => {
        const model = {
          id: 'model',
          name: 'local',
          label: 'Local',
          providerId: 'local',
          toolCalling: true,
        };
        const adapter: ModelAdapter = {
          async discover() {
            return [];
          },
          async *generate() {
            throw new Error('expected tool request');
          },
          async *generateTurn() {
            yield {
              type: 'turn',
              turn: {
                calls: [
                  { id: 'write', name: 'workspace_write', arguments: write },
                  { id: 'unlisted', name: 'unlisted_tool', arguments: {} },
                ],
                continuation: [],
              },
            };
          },
        };
        const replyContext = {
          db,
          models: {
            authorize: () => model,
            connection: () => ({
              baseUrl: 'http://fixture.invalid',
              apiMode: 'responses',
              apiKey: '',
            }),
            adapter: () => adapter,
          },
          extensions: { conversationTools: () => registry.select(user) },
        } as unknown as Context;
        await assert.rejects(
          generateReply(replyContext, {
            ...scope,
            modelId: model.id,
            messages: [{ role: 'user', content: '更新会话记忆' }],
            effort: 'none',
            calls: [],
            text() {},
            progress() {},
            productionProgress() {},
          }),
          { status: 403 },
        );
        const after = readWorkspaceDocument(ctx, user.id, conversationId, memory.id);
        assert.equal(after.version, memory.version);
        assert.notEqual(after.content, write.content);
      },
    );
    assert.match(
      (await call('workspace_write', { ...write, documentId: rules.id })).error,
      /只可编辑/,
    );
    assert.equal((await call('workspace_write', write)).document.version, memory.version + 1);
    assert.match((await call('workspace_write', write)).error, /版本/);
    assert.match((await call('workspace_write', { ...write, ownerId: 'other' })).error, /参数/);
    assert.equal(
      rememberExplicitWorkspaceNote(
        ctx,
        user.id,
        conversationId,
        scope.messageId,
        '请记住：决定使用本地归档',
      ),
      true,
    );
    assert.equal(
      rememberExplicitWorkspaceNote(
        ctx,
        user.id,
        conversationId,
        scope.messageId,
        '请记住：决定使用本地归档',
      ),
      false,
    );
    assert.equal(
      rememberExplicitWorkspaceNote(
        ctx,
        user.id,
        conversationId,
        randomUUID(),
        '这个为什么会崩溃？',
      ),
      false,
    );
    assert.match(
      readWorkspaceDocument(ctx, user.id, conversationId, memory.id).content,
      /Private decision[\s\S]+决定使用本地归档/,
    );
    assert.equal(listWorkspaceDocuments(ctx, user.id, conversationId).length, 2);
  } finally {
    await kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('steering received during final text starts one fresh billed call with chronological history', async () => {
  const requests: ProviderMessage[][] = [];
  const pending: string[] = [];
  const adapter: ModelAdapter = {
    async discover() {
      return [];
    },
    async *generate(_connection, _model, messages) {
      requests.push(structuredClone(messages));
      yield { type: 'text', text: requests.length === 1 ? '草稿' : '已按追加指令修改' };
      if (requests.length === 1) pending.push('请改用中文');
      yield { type: 'usage', usage: { input: 3, output: 1, total: 4 } };
    },
  };
  const registry = new ConversationToolRegistry();
  const ctx = {
    db: { run() {} },
    models: {
      authorize: () => ({
        toolCalling: false,
        label: 'Local',
        name: 'Local',
        providerId: 'provider',
      }),
      connection: () => ({}),
      adapter: () => adapter,
    },
    extensions: { conversationTools: () => registry.select(user) },
  } as unknown as Context;
  const calls: ExtensionCall[] = [];
  let text = '';
  await generateReply(ctx, {
    user,
    modelId: 'model',
    conversationId: 'conv',
    messageId: 'msg',
    messages: [{ role: 'user', content: 'Original' }],
    effort: 'none',
    signal: new AbortController().signal,
    calls,
    takeSteering: () => pending.splice(0),
    hasSteering: () => !!pending.length,
    text: (chunk) => {
      text += chunk;
    },
    progress() {},
    productionProgress() {},
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [
    { role: 'user', content: 'Original' },
    { role: 'assistant', content: '草稿' },
    { role: 'user', content: '请改用中文' },
  ]);
  assert.equal(text, '草稿\n\n已按追加指令修改');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.deepEqual(
    calls.map((c) => c.usage?.total),
    [4, 4],
  );
});

test('tool continuation uses current limits and stops before sending to a changed model route', async (t) => {
  const initial = {
    providerId: 'p',
    name: 'model',
    label: 'Original',
    toolCalling: true,
    granted: true,
    baseUrl: 'https://mock.invalid',
    apiKey: 'original-test-fixture',
    apiMode: 'responses',
    maxOutputTokens: 512,
    contextWindowTokens: 8192,
  };
  const scenarios: [string, Partial<typeof initial>, number | null][] = [
    ['adopts a new output cap', { maxOutputTokens: 128 }, null],
    ['enforces a reduced window', { contextWindowTokens: 550 }, 413],
    ['provider change', { providerId: 'another-provider' }, 409],
    ['model change', { name: 'another-model' }, 409],
    ['endpoint change', { baseUrl: 'https://other.invalid' }, 409],
    ['protocol change', { apiMode: 'anthropic-messages' }, 409],
    ['credential change', { apiKey: 'different-test-fixture' }, 409],
    ['revocation', { granted: false }, 403],
  ];
  for (const [label, update, status] of scenarios) {
    await t.test(label, async (t) => {
      let settings = initial;
      const adapter = new OpenAICompatibleAdapter();
      const registry = new ConversationToolRegistry();
      registry.register({
        id: 'fixture',
        instructions: 'Read the note.',
        tools: () => [
          {
            name: 'read_note',
            description: 'Read the note',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
        async execute() {
          settings = { ...settings, ...update };
          return 'Private tool result';
        },
      });
      const ctx = {
        db: { run() {} },
        models: {
          authorize: () => {
            if (!settings.granted) throw new HttpError(403, '模型未授权');
            return settings;
          },
          connection: () => ({ ...settings }),
          adapter: () => adapter,
        },
        extensions: { conversationTools: () => registry.select(user) },
      } as unknown as Context;
      const outputLimits: number[] = [];
      t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        outputLimits.push(body.max_output_tokens);
        const first = outputLimits.length === 1;
        const output = first
          ? [{ type: 'function_call', call_id: 'c', name: 'read_note', arguments: '{}' }]
          : [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Done' }],
              },
            ];
        const packets = [
          ...(!first ? [{ type: 'response.output_text.delta', delta: 'Done' }] : []),
          {
            type: 'response.completed',
            response: { output, usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } },
          },
        ];
        return new Response(
          packets.map((packet) => 'data: ' + JSON.stringify(packet) + '\n\n').join(''),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      });
      const calls: ExtensionCall[] = [];
      const reply = generateReply(ctx, {
        user,
        modelId: 'model',
        conversationId: 'chat',
        messageId: 'message',
        messages: [{ role: 'user', content: 'Read the note.' }],
        effort: 'none',
        calls,
        signal: new AbortController().signal,
        text() {},
        progress() {},
        productionProgress() {},
      });
      if (status === null) {
        await reply;
        assert.deepEqual(outputLimits, [512, 128]);
      } else {
        await assert.rejects(reply, { status });
        assert.deepEqual(outputLimits, [512]);
        assert.ok(calls.slice(1).every((call) => call.usage === null));
      }
      assert.equal(calls[0].usage?.total, 4);
    });
  }
});
