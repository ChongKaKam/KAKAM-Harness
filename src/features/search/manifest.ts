import type { FeatureManifest } from '../../shared/types';
export const manifest: FeatureManifest = {
  id: 'search',
  name: 'Search',
  description: '生成搜索词，通过 Perplexity 检索并保留信息来源',
  capability: true,
  kind: 'plugin',
  version: '0.1.0',
  adminOnly: true,
};
