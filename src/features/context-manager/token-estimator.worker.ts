import { estimateContextTokens } from './token-estimator';
import type { TokenEstimateInput, TokenEstimateResult } from './token-estimate-types';

self.onmessage = (event: MessageEvent<TokenEstimateInput>) => {
  let result: TokenEstimateResult;
  try {
    result = { data: estimateContextTokens(event.data) };
  } catch {
    result = { error: '文本 Token 估算失败，请重试。原始快照仍可查看。' };
  }
  self.postMessage(result);
};
