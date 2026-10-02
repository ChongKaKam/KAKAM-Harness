import type { ContextSectionId } from './types';

export const tokenEstimateCharacterLimit = 2_000_000;
export const tokenEstimateLimitMessage =
  '上下文文本超过 200 万字符，暂不进行本地 Token 估算；原始快照仍可查看。';
export type TokenEstimateInput = { id: ContextSectionId; texts: string[] }[];
export interface TokenEstimate {
  encoding: 'o200k_base';
  sections: { id: ContextSectionId; tokens: number }[];
  total: number;
}
export type TokenEstimateResult = { data: TokenEstimate } | { error: string };
