import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from 'cordis';
import type { ModelAdapter, ToolCall, ToolDefinition, ToolStep } from '../src/adapters/registry';
import { createApp } from '../src/server/app';
import { generateReply } from '../src/features/chat/skill-generation';
import { ConversationToolRegistry } from '../src/features/extensions/conversation-tools';
import { SkillSession } from '../src/features/extensions/skill-runtime';
import type { Skill } from '../src/features/skills/types';
import type { ExtensionCall, User } from '../src/shared/types';
import { HttpError } from '../src/kernel/http';

const fileTool: ToolDefinition = {
  name: 'production_create_file',
  description: 'Save a fixture text file',
  parameters: { type: 'object' },
};
function fileCalls(count: number, offset = 0): ToolCall[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `file-${offset + index}`,
    name: fileTool.name,
    arguments: { name: `file-${offset + index}.txt` },
  }));
}

async function fixture(
  run: (state: {
    user: User;
    conversationId: string;
    messageId: string;
    app: Awaited<ReturnType<typeof createApp>>;
    reply(batches: ToolCall[][], session?: SkillSession): Promise<void>;
    executions: string[];
    receivedSteps: ToolStep[][];
    calls: ExtensionCall[];
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'kh-production-budget-'));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp({
      dataDir: directory,
      secret: 'production-budget-fixture-secret-at-least-32-characters',
      port: 0,
      host: '127.0.0.1',
      secureCookies: false,
      trustProxy: 0,
    });
    const instance = app;
    const user: User = {
      id: randomUUID(),
      email: 'budget@example.test',
      displayName: 'Budget fixture',
      avatar: null,
      role: 'user',
      active: true,
    };
    const conversationId = randomUUID();
    const messageId = randomUUID();
    instance.kernel.ctx.db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'unused','user')",
      user.id,
      user.id,
      user.displayName,
    );
    instance.kernel.ctx.db.run(
      "INSERT INTO conversations(id,user_id,title,updated_at) VALUES(?,?,'Budget',?)",
      conversationId,
      user.id,
      new Date().toISOString(),
    );
    instance.kernel.ctx.db.run(
      "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'assistant','',?)",
      messageId,
      conversationId,
      new Date().toISOString(),
    );
    const executions: string[] = [];
    const receivedSteps: ToolStep[][] = [];
    const calls: ExtensionCall[] = [];
    const registry = new ConversationToolRegistry();
    registry.register({
      id: 'fixture-production',
      instructions: 'Save requested fixture files.',
      tools: () => [fileTool],
      async execute(scope, call) {
        executions.push(call.id);
        const artifact = instance.kernel.ctx.production.create(
          scope.user,
          {
            conversationId: scope.conversationId,
            messageId: scope.messageId,
            name: `${call.id}.txt`,
            mimeType: 'text/plain',
            data: Buffer.from(`Retained ${call.id}`),
            idempotencyKey: `${scope.requestId}:${call.id}`,
          },
          scope.signal,
        );
        return JSON.stringify({ id: artifact.id });
      },
    });
    const modelId = randomUUID();
    const reply = async (batches: ToolCall[][], session?: SkillSession) => {
      let round = 0;
      const adapter: ModelAdapter = {
        async discover() {
          return [];
        },
        async *generate() {
          assert.fail('Tool-enabled fixture must use generateTurn');
        },
        async *generateTurn(_connection, _model, _messages, _tools, steps) {
          receivedSteps.push(structuredClone(steps));
          yield { type: 'usage', usage: { input: 1, output: 1, total: 2 } };
          yield { type: 'turn', turn: { calls: batches[round++] ?? [], continuation: [] } };
        },
      };
      const ctx = {
        db: instance.kernel.ctx.db,
        models: {
          authorize: () => ({
            id: modelId,
            kind: 'llm',
            providerId: 'fixture',
            label: 'Fixture',
            name: 'fixture',
            toolCalling: true,
          }),
          connection: () => ({
            apiMode: 'chat-completions',
            baseUrl: 'http://fixture.invalid',
            apiKey: '',
          }),
          adapter: () => adapter,
        },
        extensions: { conversationTools: () => registry.select(user) },
      } as unknown as Context;
      await generateReply(ctx, {
        user,
        modelId,
        conversationId,
        messageId,
        messages: [{ role: 'user', content: 'Create fixture files.' }],
        effort: 'none',
        signal: new AbortController().signal,
        session,
        calls,
        text() {},
        progress() {},
        productionProgress() {},
      });
    };
    await run({
      user,
      conversationId,
      messageId,
      app: instance,
      reply,
      executions,
      receivedSteps,
      calls,
    });
  } finally {
    await app?.kernel.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

const blocked = (error: unknown) =>
  error instanceof HttpError && error.status === 502 && /工具/.test(error.message);

test('a single model response cannot execute more than 16 production tools; created files survive', async () => {
  await fixture(async ({ reply, executions, app, user, messageId, calls }) => {
    await assert.rejects(reply([fileCalls(18)]), blocked);
    assert.equal(executions.length, 16);
    assert.ok(!executions.includes('file-16'));
    const artifacts = app.kernel.ctx.production.forMessage(user.id, messageId);
    assert.equal(artifacts.length, 16);
    for (const artifact of artifacts)
      assert.equal(
        Buffer.from(app.kernel.ctx.production.download(user.id, artifact.id).data).toString(),
        `Retained ${artifact.name.replace(/\.txt$/, '')}`,
      );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].usage, { input: 1, output: 1, total: 2 });
  });
});

test('the 16 tool execution budget carries across model requests', async () => {
  await fixture(async ({ reply, executions, app, user, messageId, receivedSteps, calls }) => {
    await assert.rejects(reply([fileCalls(9), fileCalls(9, 9)]), blocked);
    assert.equal(executions.length, 16);
    assert.equal(app.kernel.ctx.production.forMessage(user.id, messageId).length, 16);
    assert.equal(receivedSteps.length, 2);
    assert.equal(receivedSteps[1][0].results.length, 9);
    assert.equal(calls.length, 2);
    assert.ok(!executions.includes('file-16'));
  });
});

test('Skill reads and production calls consume the same reply budget', async () => {
  await fixture(async ({ reply, executions, app, user, messageId, receivedSteps }) => {
    const skill: Skill & { scope: 'turn' } = {
      id: randomUUID(),
      name: 'budget-skill',
      title: 'Budget',
      description: '',
      tags: [],
      colorSlot: null,
      version: 1,
      fileCount: 1,
      content: 'Read supporting text.',
      files: [{ path: 'references/budget.txt', content: '0123456789abcdef' }],
      scope: 'turn',
    };
    const session = new SkillSession(user, {
      skills: [skill],
      signal: new AbortController().signal,
      provider: { resolve: () => [skill], read: () => skill },
    });
    const reads: ToolCall[] = Array.from({ length: 8 }, (_, offset) => ({
      id: `read-${offset}`,
      name: 'skills_read',
      arguments: { skillId: skill.id, path: 'references/budget.txt', offset, limit: 1 },
    }));
    await assert.rejects(reply([[...reads, ...fileCalls(4)], fileCalls(5, 4)], session), blocked);
    assert.equal(session.reads.length, 8);
    assert.equal(executions.length, 8);
    assert.equal(session.reads.length + executions.length, 16);
    assert.equal(app.kernel.ctx.production.forMessage(user.id, messageId).length, 8);
    assert.equal(receivedSteps[1][0].results.length, 12);
    assert.ok(!executions.includes('file-8'));
  });
});
