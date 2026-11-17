import type { FeatureManifest } from '../../shared/types';

export const manifest: FeatureManifest = {
  id: 'relay',
  name: '信息中转站',
  description: '私有 Markdown 与附件中转，三天自动到期，可分别确认长期保留',
  kind: 'plugin',
  version: '0.2.0',
};
