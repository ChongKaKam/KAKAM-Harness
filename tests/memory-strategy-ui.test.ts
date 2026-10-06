import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStrategyRegistry } from '../src/features/memory/strategies/default';
import { memoryStrategyClients, memoryStrategyClient } from '../src/features/memory/strategy-ui';

test('registered memory strategies have a matching dedicated settings component and schema version', () => {
  const serverStrategies = createStrategyRegistry().list();
  assert.equal(
    new Set(memoryStrategyClients.map((entry) => entry.id)).size,
    memoryStrategyClients.length,
  );
  for (const strategy of serverStrategies) {
    const client = memoryStrategyClient(strategy);
    assert.ok(client, `${strategy.id} must register its dedicated settings UI`);
    assert.equal(typeof client.Settings, 'function');
    assert.equal(
      memoryStrategyClient({ ...strategy, configVersion: strategy.configVersion + 1 }),
      undefined,
      'a mismatched configuration schema must not become selectable',
    );
  }
  for (const client of memoryStrategyClients)
    assert.ok(
      serverStrategies.some((strategy) => strategy.id === client.id),
      `${client.id} must have a registered server strategy`,
    );
});
