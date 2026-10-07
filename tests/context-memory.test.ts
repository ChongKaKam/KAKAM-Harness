import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KHKernel } from '../src/kernel';
import { createApp } from '../src/server/app';
import { ContextStore } from '../src/features/context-manager/store';
import { splitMemoryContext } from '../src/features/context-manager/memory-sections';
import { appendMemoryBlocks } from '../src/features/extensions/memory-context';
import type { MemoryContextBlock, MemoryPreparation } from '../src/shared/memory';
import type { ContextRequest, ContextTurn } from '../src/features/extensions/context-observer';

test('a recorder retained across plugin disable receives withdrawal redaction and later readmission stays visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kh-context-retired-'));
  const { kernel } = await createApp({
    dataDir: directory,
    secret: 'local-context-retired-test-secret',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  });
  try {
    const db = kernel.ctx.db;
    db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','unused','user')",
    );
    db.run(
      "INSERT INTO conversations(id,user_id,title,updated_at) VALUES('conversation','owner','Memory test','2026-10-07T00:00:00Z')",
    );
    const input: ContextTurn = {
      user: {
        id: 'owner',
        email: 'owner@example.test',
        displayName: 'Owner',
        role: 'user',
        active: true,
        avatar: null,
      },
      conversationId: 'conversation',
      messageId: 'old-turn',
      modelId: 'unused',
      modelName: 'Local fixture',
      createdAt: '2026-10-07T00:00:00Z',
      reasoningEffort: 'none',
      history: [],
      current: { role: 'user', content: '当前问题' },
    };
    const memory: MemoryContextBlock = {
      memoryId: 'readmitted',
      scope: 'user',
      version: 1,
      content: '要撤回的旧记忆',
      reason: '相关',
    };
    const request = (block: MemoryContextBlock): ContextRequest => {
      const rendered = appendMemoryBlocks(input.current.content, [block]);
      return {
        callId: 'call',
        messages: [{ role: 'user', content: rendered.content }],
        memoryRanges: rendered.ranges,
        tools: [],
        steps: [],
      };
    };
    const recorder = kernel.ctx.extensions.observeContext(input)!;
    recorder.request(request(memory));
    await kernel.toggle('context-manager', false);
    kernel.ctx.extensions.redactMemoryContext('owner', memory.memoryId, 1);
    recorder.request(request(memory));
    recorder.finish({
      id: input.messageId,
      role: 'assistant',
      content: '原回答',
      status: 'complete',
      images: [],
      createdAt: input.createdAt,
    });
    const old = db.get<{ snapshot: string }>(
      'SELECT snapshot FROM context_snapshots WHERE message_id=?',
      input.messageId,
    )!;
    assert.ok(
      !old.snapshot.includes(memory.content),
      'late recorder must not restore a withdrawn copy after plugin disable',
    );
    await kernel.toggle('context-manager', true);
    const later = kernel.ctx.extensions.observeContext({ ...input, messageId: 'new-turn' })!;
    const readmitted = { ...memory, version: 3, content: '重新纳入的版本' };
    later.request(request(readmitted));
    later.finish({
      id: 'new-turn',
      role: 'assistant',
      content: '新回答',
      status: 'complete',
      images: [],
      createdAt: input.createdAt,
    });
    assert.ok(
      db
        .get<{ snapshot: string }>(
          "SELECT snapshot FROM context_snapshots WHERE message_id='new-turn'",
        )!
        .snapshot.includes(readmitted.content),
    );
    kernel.ctx.extensions.redactMemoryContext('owner', memory.memoryId);
    assert.ok(
      !db
        .get<{ snapshot: string }>(
          "SELECT snapshot FROM context_snapshots WHERE message_id='new-turn'",
        )!
        .snapshot.includes(readmitted.content),
    );
  } finally {
    await kernel.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

const blocks: MemoryContextBlock[] = [
  {
    memoryId: 'long-memory',
    scope: 'user',
    version: 2,
    content: '喜欢中文回答 📚',
    reason: '用户的稳定偏好',
  },
  {
    memoryId: 'group-memory',
    scope: 'group',
    version: 1,
    content: '项目使用 PostgreSQL',
    reason: '项目背景',
  },
  {
    memoryId: 'session-memory',
    scope: 'session',
    version: 3,
    content: '正在完成设置页',
    reason: '当前任务',
  },
];

test('memory ranges split decorated UTF-16 text once and preserve unrelated appended content', () => {
  const original = '继续实现 🧭';
  const before = `${original}\nSkill 文档`;
  const rendered = appendMemoryBlocks(before, blocks);
  const actual = `${rendered.content}\nSearch 结果`;
  const split = splitMemoryContext(actual, original, rendered.ranges);
  assert.equal(split.appended, '\nSkill 文档\nSearch 结果');
  assert.deepEqual(
    split.entries.map((entry) => entry.memoryScope),
    ['user', 'group', 'session'],
  );
  assert.equal(split.entries[0].memoryVersion, 2);
  assert.equal(split.entries[0].memoryReason, '用户的稳定偏好');
  assert.equal(
    original.length +
      split.appended.length +
      split.entries.reduce((sum, entry) => sum + entry.content.length, 0),
    actual.length,
  );
  assert.equal(
    split.entries[0].content,
    actual.slice(rendered.ranges[0].start, rendered.ranges[0].end),
  );
  const malformed = splitMemoryContext(actual, original, [
    { ...rendered.ranges[0], start: -1 },
    { ...rendered.ranges[1], end: actual.length + 1 },
    { ...rendered.ranges[2], start: Number.NaN },
  ]);
  assert.equal(malformed.entries.length, 0);
  assert.equal(malformed.appended, actual.slice(original.length));
});

test('snapshots isolate three memory scopes, keep old four-section requests, and redact active recorder copies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kh-context-memory-'));
  const kernel = new KHKernel(directory);
  try {
    const db = kernel.ctx.db;
    db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','placeholder','user')",
    );
    db.run(
      "INSERT INTO conversations(id,user_id,title,updated_at) VALUES('conversation','owner','Memory test','2026-10-06T00:00:00Z')",
    );
    const store = new ContextStore(db);
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
      messageId: 'assistant-memory',
      modelId: 'model',
      modelName: 'Fixture',
      createdAt: '2026-10-06T00:00:00Z',
      reasoningEffort: 'none',
      history: [],
      current: { role: 'user', content: '当前提问 🧭' },
    };
    const recorder = store.begin(turn);
    assert.equal(store.get('owner', 'conversation', turn.messageId).sections.length, 4);
    const rendered = appendMemoryBlocks(`${turn.current.content}\nSkill`, blocks);
    const preparation: MemoryPreparation = {
      operationId: 'recall',
      strategyId: 'default',
      strategyVersion: '1',
      status: 'ready',
      durationMs: 8,
      error: null,
      blocks,
      omittedIds: [],
    };
    const request: ContextRequest = {
      callId: 'call',
      messages: [{ role: 'user', content: rendered.content }],
      tools: [],
      steps: [],
      memory: preparation,
      memoryRanges: rendered.ranges,
    };
    recorder.request(request);
    recorder.request(request);
    const snapshot = store.get('owner', 'conversation', turn.messageId);
    assert.deepEqual(
      snapshot.sections.map((part) => part.id),
      ['system', 'long-term', 'group', 'session', 'current'],
    );
    assert.equal(snapshot.characters, rendered.content.length);
    assert.equal(snapshot.bytes, Buffer.byteLength(rendered.content));
    assert.equal(snapshot.requestCount, 1);
    assert.equal(
      snapshot.sections.find((part) => part.id === 'group')?.entries[0].memoryId,
      'group-memory',
    );
    assert.equal(
      snapshot.sections
        .find((part) => part.id === 'session')
        ?.entries.filter((entry) => entry.memoryId).length,
      1,
    );
    assert.equal(
      snapshot.sections.find((part) => part.id === 'session')?.entries.at(-1)?.content,
      '\nSkill',
    );
    store.redactMemory('owner', 'long-memory');
    recorder.request({ ...request, callId: 'second-call' });
    recorder.finish({
      id: turn.messageId,
      role: 'assistant',
      content: '回答已完成',
      images: [],
      status: 'complete',
      createdAt: turn.createdAt,
    });
    const redacted = store.get('owner', 'conversation', turn.messageId);
    assert.ok(!JSON.stringify(redacted).includes('喜欢中文回答'));
    assert.ok(!JSON.stringify(redacted).includes('用户的稳定偏好'));
    assert.equal(
      redacted.sections.find((part) => part.id === 'long-term')?.entries[0].memoryDeleted,
      true,
    );
    assert.ok(
      redacted.sections
        .find((part) => part.id === 'group')
        ?.entries[0].content.includes('项目使用 PostgreSQL'),
    );
    assert.equal(
      redacted.characters,
      redacted.sections.reduce((sum, part) => sum + part.characters, 0),
    );
    assert.equal(
      preparation.blocks[0].content,
      '喜欢中文回答 📚',
      'observer must not mutate caller metadata',
    );
    assert.throws(() => store.get('another-user', 'conversation', turn.messageId), /对话不存在/);
  } finally {
    await kernel.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
