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

test('delivery requirements and available tools refresh after each server-bound tool result', async () => {
  const registry = new ConversationToolRegistry();
  let declared = false,
    delivered = false;
  const plan = { ...definition, name: 'example_plan' };
  registry.register({
    id: 'dynamic',
    instructions: 'Declare and deliver.',
    tools: (_, current) => (current?.requireDelivery && !declared ? [plan] : [plan, definition]),
    requirement: (_, __, required) =>
      required
        ? {
            toolName: plan.name,
            instructions: 'Declare first.',
            failureMessage: 'No plan',
            satisfied: () => declared,
          }
        : undefined,
    requirements: () =>
      declared
        ? [
            {
              toolName: definition.name,
              instructions: 'Deliver item.',
              failureMessage: 'No file',
              satisfied: () => delivered,
            },
          ]
        : [],
    execute: async (_, call) => {
      if (call.name === plan.name) declared = true;
      else delivered = true;
      return '{}';
    },
  });
  const selected = registry.select(user, '', true);
  const current = { ...scope, requireDelivery: true };
  assert.deepEqual(
    selected.toolsFor(current).map((tool) => tool.name),
    [plan.name],
  );
  assert.equal(selected.pending(current)[0].failureMessage, 'No plan');
  await assert.rejects(
    selected.execute(current, { id: 'early', name: definition.name, arguments: {} }),
    /未授权/,
  );
  await selected.execute(current, { id: 'plan', name: plan.name, arguments: {} });
  assert.equal(selected.pending(current)[0].failureMessage, 'No file');
  assert.deepEqual(
    selected.toolsFor(current).map((tool) => tool.name),
    [plan.name, definition.name],
  );
  await selected.execute(current, { id: 'file', name: definition.name, arguments: {} });
  assert.deepEqual(selected.pending(current), []);
});

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

test('newly authorized definitions execute through the pinned provider without stale tool mapping', async () => {
  const registry = new ConversationToolRegistry();
  let enabled = false;
  const release = registry.register({
    id: 'example',
    instructions: 'Create.',
    tools: () => (enabled ? [definition] : []),
    execute: async () => 'saved',
  });
  const selected = registry.select(user);
  assert.deepEqual(selected.tools, []);
  enabled = true;
  assert.deepEqual(selected.toolsFor(scope), [definition]);
  assert.equal(
    await selected.execute(scope, { id: 'new', name: definition.name, arguments: {} }),
    'saved',
  );
  release();
  await assert.rejects(
    selected.execute(scope, { id: 'released', name: definition.name, arguments: {} }),
    /未授权/,
  );
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
