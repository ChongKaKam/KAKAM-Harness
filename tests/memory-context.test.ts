import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendMemoryBlocks,
  redactMemorySnapshot,
  renderMemoryBlock,
} from '../src/features/extensions/memory-context';
import type { MemoryContextBlock } from '../src/shared/memory';

test('memory request ranges preserve decorated text exactly and deletion scrubs copied text and counts', () => {
  const block: MemoryContextBlock = {
    memoryId: 'private-id',
    version: 2,
    scope: 'group',
    content: '项目约定：中文界面 🧭',
    reason: '相关项目约定',
  };
  const current = '本轮输入\n\nSkill / Search 追加内容';
  const rendered = appendMemoryBlocks(current, [block]);
  assert.equal(rendered.content.slice(0, rendered.ranges[0].start), current);
  assert.equal(
    rendered.content.slice(rendered.ranges[0].start, rendered.ranges[0].end),
    renderMemoryBlock(block),
  );
  assert.equal(rendered.ranges[0].end, rendered.content.length);
  const snapshot = {
    sections: [
      {
        id: 'group',
        entries: [
          {
            memoryId: block.memoryId,
            content: renderMemoryBlock(block),
            reason: block.reason,
            images: [],
          },
        ],
        characters: 0,
        bytes: 0,
        imageCount: 0,
      },
    ],
    memory: { blocks: [{ ...block }] },
    response: '原聊天回复保持完整',
    characters: 0,
    bytes: 0,
    imageCount: 0,
  };
  assert.equal(redactMemorySnapshot(snapshot, block.memoryId), true);
  assert.equal(snapshot.sections[0].entries[0].content, '[记忆已删除]');
  assert.equal(snapshot.memory.blocks[0].content, '[记忆已删除]');
  assert.equal(snapshot.response, '原聊天回复保持完整');
  assert.equal(snapshot.characters, '[记忆已删除]'.length);
  assert.equal(snapshot.bytes, Buffer.byteLength('[记忆已删除]', 'utf8'));
  assert.equal(JSON.stringify(snapshot).includes(block.content), false);
  assert.equal(redactMemorySnapshot(snapshot, 'another-owner-memory'), false);
});
