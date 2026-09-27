import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActivity } from '../src/features/usage/activity';
const now = new Date('2026-09-27T23:59:59Z');
const rows = [
  { day: '2026-09-20', model: 'A', total: 10, requests: 1 },
  { day: '2026-09-21', model: 'B', total: 20, requests: 2 },
  { day: '2026-09-27', model: 'A', total: 30, requests: 1 },
];
test('heatmap fills missing UTC days, groups Monday weeks and accumulates within the selected range', () => {
  const daily = buildActivity(rows, 8, 'daily', now);
  assert.equal(daily.length, 8);
  assert.equal(daily[2].total, 0);
  const weekly = buildActivity(rows, 8, 'weekly', now);
  assert.deepEqual(
    weekly.map((c) => c.total),
    [10, 50],
  );
  assert.equal(weekly[1].end, '2026-09-27');
  const cumulative = buildActivity(rows, 8, 'cumulative', now);
  assert.deepEqual(
    cumulative.map((c) => c.total),
    [10, 30, 30, 30, 30, 30, 30, 60],
  );
  assert.deepEqual(cumulative.at(-1)?.models, { A: 40, B: 20 });
  assert.equal(buildActivity(rows, 7, 'cumulative', now).at(-1)?.total, 50);
});
