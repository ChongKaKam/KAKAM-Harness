import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KHKernel } from '../src/kernel';
import { MemoryManager } from '../src/features/memory/manager';
import { defaultConfig, defaultPreferences } from '../src/features/memory/config';
import { digest, type MemoryRepository } from '../src/features/memory/repository';
import type {
  DefaultMemoryConfig,
  MemoryItem,
  MemoryOperation,
  MemoryPreferences,
  MemoryTurnInput,
} from '../src/shared/memory';
import type { Message, User } from '../src/shared/types';

async function fixture(
  run: (state: {
    manager: MemoryManager;
    input: MemoryTurnInput;
    candidates: MemoryItem[];
    operations: Map<string, MemoryOperation>;
    saved: MemoryItem[];
    config: DefaultMemoryConfig;
    preferences: MemoryPreferences;
    repository: MemoryRepository;
    embeddingSpaceSource: { baseUrl: string; apiMode: string };
    llm(work: (signal: AbortSignal) => Promise<string>): void;
    complete(current: string): Promise<void>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'drift-memory-manager-'));
  const kernel = new KHKernel(directory);
  try {
    const user: User = {
      id: randomUUID(),
      email: null,
      displayName: 'Owner',
      avatar: null,
      role: 'user',
      active: true,
    };
    const conversationId = randomUUID(),
      groupId = randomUUID();
    const preferences: MemoryPreferences = {
      ...defaultPreferences,
      enabled: true,
      embeddingModelId: randomUUID(),
      recallModelId: randomUUID(),
      extractModelId: randomUUID(),
      writeModes: { ...defaultPreferences.writeModes },
      retentionDays: { ...defaultPreferences.retentionDays },
    };
    const config = { ...defaultConfig, scopeLimits: { ...defaultConfig.scopeLimits } };
    const db = kernel.ctx.db,
      now = new Date().toISOString();
    db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'unused','user')",
      user.id,
      user.id,
      user.displayName,
    );
    db.run(
      'INSERT INTO conversation_groups(id,user_id,name,created_at) VALUES(?,?,?,?)',
      groupId,
      user.id,
      '项目',
      now,
    );
    db.run(
      'INSERT INTO conversations(id,user_id,title,group_id,updated_at) VALUES(?,?,?,?,?)',
      conversationId,
      user.id,
      'Memory',
      groupId,
      now,
    );
    const candidates: MemoryItem[] = [
      {
        id: randomUUID(),
        scope: 'user',
        scopeId: null,
        kind: 'preference',
        content: '用户喜欢旅行摄影',
        pinned: true,
        similarity: 0.05,
      },
      {
        id: randomUUID(),
        scope: 'group',
        scopeId: groupId,
        kind: 'fact',
        content: '项目采用向量指令',
        pinned: false,
        similarity: 0.8,
      },
    ].map((item) => ({
      ...item,
      status: 'active',
      version: 1,
      tags: [],
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
      admittedAt: null,
      sources: [],
    })) as MemoryItem[];
    const operations = new Map<string, MemoryOperation>(),
      saved: MemoryItem[] = [];
    const repository = {
      ready: true,
      error: null,
      initialized: async () => {},
      interruptOperations: async () => {},
      close: async () => {},
      preferences: async () => preferences,
      config: async () => ({ version: 2, config }),
      scopeRows: async () => [],
      sourceRows: async () => [],
      expired: async () => [],
      expiredScopes: async () => [],
      touch: async () => {},
      spaces: async () => [],
      ensureSpace: async () => ({ id: 'space', dimensions: 3 }),
      candidates: async () => candidates,
      get: async (_owner: string, id: string) =>
        [...candidates, ...saved].find((item) => item.id === id)!,
      scopeState: async () => ({ selections: {}, summary: '', revision: 0 }),
      beginOperation: async (
        _owner: string,
        type: string,
        _strategy: string,
        facts: Record<string, unknown>,
      ) => {
        const operation: MemoryOperation = {
          id: randomUUID(),
          type,
          state: 'running',
          createdAt: now,
          finishedAt: null,
          error: null,
          facts,
        };
        operations.set(operation.id, operation);
        return { created: true, operation };
      },
      finishOperation: async (
        _owner: string,
        id: string,
        state: MemoryOperation['state'],
        facts: Record<string, unknown> = {},
        error?: string,
      ) => {
        const operation = operations.get(id)!;
        Object.assign(operation, {
          state,
          facts: { ...operation.facts, ...facts },
          error: error ?? null,
        });
      },
      getOperation: async (_owner: string, id: string) => operations.get(id)!,
      create: async (_owner: string, item: MemoryItem, sources: MemoryItem['sources']) => {
        const memory = {
          ...item,
          id: randomUUID(),
          version: 1,
          status: item.scope === 'user' ? 'pending' : 'active',
          sources,
        } as MemoryItem;
        saved.push(memory);
        return memory;
      },
      saveProposal: async () => ({ id: randomUUID() }),
      storeVector: async () => true,
      unindexed: async () => [],
      activateSpace: async () => {},
      setIndexStatus: async () => {},
    } as unknown as MemoryRepository;
    let llmWork = async (_signal: AbortSignal) => '{"selected":[]}';
    const embeddingSpaceSource = { baseUrl: 'http://fixture.invalid', apiMode: 'responses' };
    kernel.ctx.provide('models', {
      authorize: (_user: User, id: string) => ({
        id,
        providerId: 'fixture',
        name: id,
        embeddingDimensions: 3,
      }),
      embeddingSpaceSource: () => embeddingSpaceSource,
      embed: async () => ({ vectors: [[1, 0, 0]], dimensions: 3 }),
    });
    kernel.ctx.provide('extensions', {
      registerMemoryProvider: () => () => {},
      registerUtility: () => () => {},
      generateUtility: async (
        _user: User,
        _purpose: string,
        _model: string,
        _prompt: string,
        signal: AbortSignal,
      ) => ({ text: await llmWork(signal) }),
    });
    kernel.ctx.plugin(MemoryManager, { configured: true, repository });
    await kernel.ctx.events.flush();
    const manager = kernel.ctx.memory;
    const input: MemoryTurnInput = {
      user,
      conversationId,
      groupId,
      messageId: randomUUID(),
      current: '解析向量指令',
      history: [],
      signal: new AbortController().signal,
    };
    await run({
      manager,
      input,
      candidates,
      operations,
      saved,
      config,
      preferences,
      repository,
      embeddingSpaceSource,
      llm(work) {
        llmWork = work;
      },
      async complete(current) {
        const userId = randomUUID(),
          responseId = randomUUID();
        for (const [id, role, content] of [
          [userId, 'user', current],
          [responseId, 'assistant', '已完成的回答'],
        ])
          db.run(
            'INSERT INTO messages(id,conversation_id,role,content,status,created_at) VALUES(?,?,?,?,?,?)',
            id,
            conversationId,
            role,
            content,
            'complete',
            now,
          );
        const response: Message = {
          id: responseId,
          role: 'assistant',
          content: '已完成的回答',
          status: 'complete',
          createdAt: now,
          images: [],
        };
        await manager.complete({ ...input, current, messageId: responseId, response });
      },
    });
  } finally {
    await kernel.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

test('recall reuses the original index after retiring a conversation protocol and keeps changed endpoints isolated', async (t) => {
  await fixture(async ({ manager, input, preferences, repository, embeddingSpaceSource }) => {
    const modelId = preferences.embeddingModelId!;
    // Freeze the on-disk v1 identity used before the protocol migration.
    const spaces = ['chat-completions', 'responses'].map((apiMode) => ({
      id: 'space-' + apiMode,
      modelId,
      state: 'active' as const,
      createdAt: '',
      dimensions: 3,
      fingerprint: digest(
        JSON.stringify({
          id: modelId,
          provider: 'fixture',
          name: modelId,
          baseUrl: 'http://fixture.invalid',
          apiMode,
          dimensions: 3,
          version: 1,
        }),
      ),
    }));
    t.mock.method(repository, 'spaces', async () => spaces);
    const createSpace = t.mock.method(repository, 'ensureSpace');
    const search = t.mock.method(repository, 'candidates');
    for (const apiMode of ['chat-completions', 'responses']) {
      embeddingSpaceSource.apiMode = apiMode;
      await manager.search(input.user, '原有记忆');
      assert.equal(search.mock.calls.at(-1)!.arguments[2], 'space-' + apiMode);
    }
    assert.equal(createSpace.mock.callCount(), 0);
    embeddingSpaceSource.baseUrl = 'http://another-fixture.invalid';
    await manager.search(input.user, '新来源');
    assert.equal(createSpace.mock.callCount(), 1);
    const newFingerprint = createSpace.mock.calls[0].arguments[2];
    assert.ok(spaces.every((entry) => entry.fingerprint !== newFingerprint));
  });
});
