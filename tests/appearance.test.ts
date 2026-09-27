import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorPatterns,
  ColorPatternRegistry,
  shellTokens,
  patternFromAccent,
  swatchForeground,
} from '../src/shared/appearance';
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
test('neutral shell and every pattern component retain readable text in both modes', () => {
  for (const mode of ['light', 'dark'] as const) {
    const shell = shellTokens(mode);
    for (const [token, color] of Object.entries(shell))
      assert.ok(/^#([0-9a-f]{2})\1\1$/i.test(color), `${mode}/${token} must be pure grayscale`);
    for (const background of ['--surface', '--sidebar', '--surface-alt'] as const)
      for (const text of ['--ink', '--muted', '--faint'] as const)
        assert.ok(contrast(shell[text], shell[background]) >= 4.5, `${mode}/${text}/${background}`);
    assert.ok(contrast(shell['--primary'], shell['--on-primary']) >= 4.5);
    for (const pattern of colorPatterns.list())
      for (let slot = 0; slot < pattern.colors.length; slot++) {
        const { color, tokens } = colorPatterns.resolve(pattern.id, mode, { key: 'fixture', slot });
        for (const text of ['--ink', '--muted'] as const)
          assert.ok(
            contrast(shell[text], tokens['--item-fill']) >= 4.5,
            `${pattern.id}/${slot}/${mode}/${text}`,
          );
        assert.ok(contrast(color.color, swatchForeground(color.color)) >= 4.5);
      }
  }
});
test('color mapping is deterministic and manual slots survive palette changes and ordering', () => {
  const a = colorPatterns.resolve('natural', 'light', { key: 'conversation-1' });
  assert.deepEqual(a, colorPatterns.resolve('natural', 'light', { key: 'conversation-1' }));
  assert.equal(
    colorPatterns.resolve('classic', 'light', { key: 'changed-key', slot: 6 }).color.id,
    'blue-gray',
  );
  assert.equal(
    colorPatterns.resolve('natural', 'dark', { key: 'changed-key', slot: 6 }).color.id,
    'lake',
  );
  const slots = [0, 1, 2].map(
    (index) => colorPatterns.resolve('natural', 'light', { key: 'cards', index }).index,
  );
  assert.equal(new Set(slots).size, 3);
  assert.equal(patternFromAccent('soft-pink'), 'classic');
  assert.equal(patternFromAccent('sage'), 'natural');
});
test('new patterns plug into the shared registry with validation and arbitrary palette lengths', () => {
  const registry = new ColorPatternRegistry();
  const pattern = {
    id: 'custom',
    name: 'Custom',
    description: 'Fixture',
    colors: [{ id: 'red', name: 'Red', original: 'Red', color: '#aa6655' }],
  };
  registry.register(pattern);
  assert.equal(registry.resolve('custom', 'dark', { key: 'any', slot: 63 }).index, 0);
  assert.equal(registry.resolve('custom', 'light', { key: 'any' }).color.color, '#aa6655');
  assert.throws(() => registry.register(pattern));
  assert.throws(() => registry.register({ ...pattern, id: 'empty', colors: [] }));
  assert.throws(() => registry.get('missing'));
  assert.throws(() => registry.resolve('custom', 'dark', { key: 'any', slot: -1 }));
  assert.throws(() =>
    registry.register({
      ...pattern,
      id: 'bad-opacity',
      tint: { light: { fill: 2, soft: 0, line: 0 }, dark: { fill: 0, soft: 0, line: 0 } },
    }),
  );
});
