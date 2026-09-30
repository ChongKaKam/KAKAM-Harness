import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSourceProbeDelay } from '../src/features/models/probe-schedule';

const minutes = (value: number) => value * 60_000;

test('source checks follow two-hour daytime slots in China Standard Time', () => {
  assert.equal(nextSourceProbeDelay(new Date('2026-09-30T23:30:00Z')), minutes(30));
  assert.equal(nextSourceProbeDelay(new Date('2026-10-01T00:00:00Z')), minutes(120));
  assert.equal(nextSourceProbeDelay(new Date('2026-10-01T09:20:00Z')), minutes(40));
});

test('source checks pause overnight and resume at 08:00 the next day', () => {
  assert.equal(nextSourceProbeDelay(new Date('2026-10-01T10:00:00Z')), minutes(14 * 60));
  assert.equal(nextSourceProbeDelay(new Date('2026-10-01T11:30:00Z')), minutes(12 * 60 + 30));
});
