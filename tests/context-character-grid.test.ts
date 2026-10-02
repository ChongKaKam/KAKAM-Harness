import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterGrid } from '../src/features/context-manager/character-grid';

test('reference-sized context fills separate 64-character blocks and leaves gray cells', () => {
  const grid = characterGrid([
    { id: 'system', characters: 0 },
    { id: 'long-term', characters: 0 },
    { id: 'session', characters: 6882 },
    { id: 'current', characters: 16 },
  ]);
  assert.equal(grid.charactersPerCell, 64);
  assert.equal(grid.cells.length, 224);
  assert.deepEqual(grid.cells.slice(0, 108), Array(108).fill('session'));
  assert.equal(grid.cells[108], 'current');
  assert.deepEqual(grid.cells.slice(109), Array(115).fill(null));
});

test('empty input remains gray and large sections use a stated coarser scale without truncation', () => {
  const empty = characterGrid([{ id: 'current', characters: 0 }]);
  assert.equal(empty.charactersPerCell, 64);
  assert.ok(empty.cells.every((cell) => cell === null));
  const exact = characterGrid([{ id: 'session', characters: 224 * 64 }]);
  assert.equal(exact.charactersPerCell, 64);
  assert.equal(exact.cells.filter(Boolean).length, 224);
  const larger = characterGrid([
    { id: 'session', characters: 224 * 64 },
    { id: 'current', characters: 1 },
  ]);
  assert.equal(larger.charactersPerCell, 128);
  assert.equal(larger.cells.filter((cell) => cell === 'session').length, 112);
  assert.equal(larger.cells[112], 'current');
  assert.equal(larger.cells.length, 224);
});
