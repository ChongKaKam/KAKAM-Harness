import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KHKernel } from '../src/kernel';
import { ContextStore } from '../src/features/context-manager/store';
import { splitMemoryContext } from '../src/features/context-manager/memory-sections';
import { appendMemoryBlocks } from '../src/features/extensions/memory-context';
import type { MemoryContextBlock, MemoryPreparation } from '../src/shared/memory';
import type { ContextRequest, ContextTurn } from '../src/features/extensions/context-observer';

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
