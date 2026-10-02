import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateContextTokens } from '../src/features/context-manager/token-estimator';
import { tokenEstimateCharacterLimit } from '../src/features/context-manager/token-estimate-types';

test('reference tokenizer counts multilingual section text and literal special-token spellings', () => {
  const result = estimateContextTokens([
    { id: 'system', texts: [] },
    { id: 'long-term', texts: [''] },
    { id: 'session', texts: ['Hello world', '你好世界'] },
    { id: 'current', texts: ['<|endoftext|>'] },
  ]);
  assert.deepEqual(result, {
    encoding: 'o200k_base',
    sections: [
      { id: 'system', tokens: 0 },
      { id: 'long-term', tokens: 0 },
      { id: 'session', tokens: 4 },
      { id: 'current', tokens: 7 },
    ],
    total: 11,
  });
});

test('empty input stays zero and oversized text is rejected without partial estimates', () => {
  assert.equal(estimateContextTokens([{ id: 'current', texts: [''] }]).total, 0);
  assert.throws(
    () =>
      estimateContextTokens([
        { id: 'session', texts: ['a'.repeat(tokenEstimateCharacterLimit)] },
        { id: 'current', texts: ['b'] },
      ]),
    /超过 200 万字符/,
  );
});
