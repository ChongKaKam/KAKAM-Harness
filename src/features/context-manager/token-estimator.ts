import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import {
  tokenEstimateCharacterLimit,
  tokenEstimateLimitMessage,
  type TokenEstimate,
  type TokenEstimateInput,
} from './token-estimate-types';

/** Reference text tokenization only; never a provider usage or billing measurement. */
export function estimateContextTokens(input: TokenEstimateInput): TokenEstimate {
  const characters = input.reduce(
    (sum, part) => sum + part.texts.reduce((n, text) => n + text.length, 0),
    0,
  );
  if (characters > tokenEstimateCharacterLimit) throw new Error(tokenEstimateLimitMessage);
  const sections = input.map(({ id, texts }) => ({
    id,
    // A literal special-token spelling in a document remains ordinary user text.
    tokens: texts.reduce(
      (sum, text) => sum + countTokens(text, { disallowedSpecial: new Set() }),
      0,
    ),
  }));
  return {
    encoding: 'o200k_base',
    sections,
    total: sections.reduce((sum, part) => sum + part.tokens, 0),
  };
}
