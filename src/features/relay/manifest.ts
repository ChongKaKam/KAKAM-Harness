import type { FeatureManifest } from '../../shared/types';

export const manifest: FeatureManifest = {
  id: 'relay',
  name: '信息中转站',
  description: '暂存 Markdown 卡片，三天自动到期，确认后长期保留',
  kind: 'plugin',
  version: '0.1.0',
};
