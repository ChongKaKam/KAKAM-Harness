import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from 'cordis';
import type { ModelAdapter } from '../src/adapters/registry';
import { KHKernel } from '../src/kernel';
import { generateReply } from '../src/features/chat/skill-generation';
import { ContextStore } from '../src/features/context-manager/store';
import { ConversationToolRegistry } from '../src/features/extensions/conversation-tools';
import { registerProductionTools } from '../src/features/llm-production/tools';
import { appendMemoryBlocks, renderMemoryBlock } from '../src/features/extensions/memory-context';
import type { ContextTurn } from '../src/features/extensions/context-observer';
import type { MemoryContextBlock, MemoryPreparation } from '../src/shared/memory';

for (const dynamic of [false, true])
  test(`actual request memory ranges survive ${dynamic ? 'changing delivery requirements across rounds' : 'production tool instructions'}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drift-memory-request-'));
    const kernel = new KHKernel(directory);
    try {
      const db = kernel.ctx.db;
      db.run(
        "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','unused','user')",
      );
      db.run(
        "INSERT INTO conversations(id,user_id,title,updated_at) VALUES('conversation','owner','Memory',?)",
        new Date().toISOString(),
      );
      const turn: ContextTurn = {
        user: {
          id: 'owner',
          email: null,
          displayName: 'Owner',
          avatar: null,
          role: 'user',
          active: true,
        },
        conversationId: 'conversation',
        messageId: 'reply',
        modelId: 'model',
        modelName: 'Mock',
        createdAt: new Date().toISOString(),
        reasoningEffort: 'none',
        history: [],
        current: { role: 'user', content: '解析掩码控制的向量指令 🧭' },
      };
      const blocks: MemoryContextBlock[] = ['user', 'group', 'session'].map((scope, index) => ({
        memoryId: `memory-${index}`,
        version: index + 1,
        scope: scope as MemoryContextBlock['scope'],
        content: `真实${scope}记忆：处理器与向量开发`,
        reason: '与当前开发任务相关',
      }));
      const prepared: MemoryPreparation = {
        operationId: null,
        strategyId: 'default',
        strategyVersion: '1',
        status: 'ready',
        blocks,
        durationMs: 1,
        error: null,
        omittedIds: [],
      };
      const appended = appendMemoryBlocks(`${turn.current.content}\nSkill 参考资料`, blocks);
      const store = new ContextStore(db),
        recorder = store.begin(turn);
      const registry = new ConversationToolRegistry();
      let completed = 0,
        requests = 0;
      const tool = {
        name: 'example_create',
        description: 'Local fixture',
        parameters: { type: 'object' },
      };
      if (dynamic)
        registry.register({
          id: 'fixture',
          instructions: '工具说明：不得展示为用户记忆。'.repeat(80),
          tools: () => [tool],
          requirements: () =>
            completed === 1
              ? [
                  {
                    toolName: tool.name,
                    instructions: '本轮新增的交付要求 🧭'.repeat(25),
                    failureMessage: '未完成',
                    satisfied: () => completed >= 2,
                  },
                ]
              : [],
          async execute() {
            completed++;
            return '{"saved":true}';
          },
        });
      const adapter: ModelAdapter = {
        async discover() {
          return [];
        },
        async *generate() {},
        async *generateTurn() {
          yield {
            type: 'turn',
            turn: {
              calls:
                dynamic && completed < 2
                  ? [{ id: `tool-${completed}`, name: tool.name, arguments: {} }]
                  : [],
              continuation: [],
            },
          };
        },
      };
      const ctx = {
        db,
        production: {
          preferences: () => ({ enabled: true, imageModelId: null }),
          delivery: () => null,
          imageFailure: () => null,
        },
        models: {
          authorize: () => ({
            id: 'model',
            providerId: 'mock',
            name: 'mock',
            label: 'Mock',
            toolCalling: true,
          }),
          connection: () => ({}),
          adapter: () => adapter,
        },
        extensions: {
          registerConversationTools: (provider: Parameters<typeof registry.register>[0]) =>
            registry.register(provider),
          conversationTools: () => registry.select(turn.user),
        },
      } as unknown as Context;
      if (!dynamic) registerProductionTools(ctx);
      await generateReply(ctx, {
        user: turn.user,
        conversationId: turn.conversationId,
        messageId: turn.messageId,
        modelId: turn.modelId,
        requestContent: turn.current.content,
        messages: [{ role: 'user', content: appended.content }],
        memory: prepared,
        memoryRanges: appended.ranges,
        effort: 'none',
        signal: new AbortController().signal,
        calls: [],
        text() {},
        progress() {},
        productionProgress() {},
        recorder: {
          finish() {},
          request(request) {
            requests++;
            recorder.request(request);
            const snapshot = store.get(turn.user.id, turn.conversationId, turn.messageId);
            const entries = snapshot.sections
              .flatMap((part) => part.entries)
              .filter((entry) => entry.memoryId);
            assert.equal(entries.length, blocks.length);
            for (const block of blocks)
              assert.ok(
                entries.find((entry) => entry.memoryId === block.memoryId)?.content ===
                  renderMemoryBlock(block),
                `${block.scope} memory must show the actual memory, not tool instructions`,
              );
            const actualCharacters =
              request.messages.reduce((sum, message) => sum + message.content.length, 0) +
              request.tools.reduce((sum, item) => sum + JSON.stringify(item).length, 0) +
              request.steps.reduce(
                (sum, step) =>
                  sum +
                  step.text.length +
                  step.calls.reduce((n, call) => n + JSON.stringify(call).length, 0) +
                  step.results.reduce((n, result) => n + result.output.length, 0),
                0,
              );
            assert.equal(
              snapshot.characters,
              actualCharacters,
              'original current prompt is counted exactly once after prepending instructions',
            );
          },
        },
      });
      assert.equal(requests, dynamic ? 3 : 1);
      assert.deepEqual(
        appended.ranges.map(({ start, end }) => ({ start, end })),
        appendMemoryBlocks(`${turn.current.content}\nSkill 参考资料`, blocks).ranges.map(
          ({ start, end }) => ({ start, end }),
        ),
        'per-round remapping does not mutate the original offsets',
      );
    } finally {
      await kernel.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
