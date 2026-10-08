import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationToolRegistry } from '../src/features/extensions/conversation-tools';
import type { User } from '../src/shared/types';

const user: User = {
  id: 'owner',
  email: 'owner@example.test',
  displayName: 'Owner',
  avatar: null,
  role: 'user',
  active: true,
};
const scope = {
  user,
  conversationId: 'conversation',
  messageId: 'message',
  requestId: 'request',
  signal: new AbortController().signal,
};
const definition = {
  name: 'example_create',
  description: 'Example',
  parameters: { type: 'object' },
};

test('registered asynchronous tools retain server-bound owner/scope and revalidate availability', async () => {
  const registry = new ConversationToolRegistry();
  let enabled = true;
  registry.register({
    id: 'example',
    instructions: 'Create files.',
    tools: () => (enabled ? [definition] : []),
    execute: async (received, call) => {
      assert.equal(received.user, user);
      assert.equal(received.conversationId, scope.conversationId);
      assert.equal(received.messageId, scope.messageId);
      assert.equal(received.requestId, scope.requestId);
      return JSON.stringify(call.arguments);
    },
  });
  const selected = registry.select(user);
  assert.equal(selected.tools.length, 1);
  assert.equal(
    await selected.execute(scope, {
      id: 'call',
      name: 'example_create',
      arguments: { owner: 'untrusted' },
    }),
    '{"owner":"untrusted"}',
  );
  enabled = false;
  await assert.rejects(
    selected.execute(scope, { id: 'call', name: 'example_create', arguments: {} }),
    /未授权/,
  );
  assert.deepEqual(registry.select(user).tools, []);
});

test('tool provider release aborts an in-flight tool and revokes pinned definitions', async () => {
  const registry = new ConversationToolRegistry();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const release = registry.register({
    id: 'example',
    instructions: 'Create files.',
    tools: () => [definition],
    execute: async (received) => {
      started();
      return new Promise((_, reject) =>
        received.signal.addEventListener('abort', () => reject(received.signal.reason), {
          once: true,
        }),
      );
    },
  });
  const selected = registry.select(user);
  const running = selected.execute(scope, { id: 'call', name: 'example_create', arguments: {} });
  const rejected = assert.rejects(running);
  await ready;
  release();
  await rejected;
  assert.deepEqual(registry.select(user).tools, []);
  await assert.rejects(
    selected.execute(scope, { id: 'call', name: 'example_create', arguments: {} }),
    /未授权/,
  );
});
