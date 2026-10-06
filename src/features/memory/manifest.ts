import type { FeatureManifest } from '../../shared/types';
export const manifest: FeatureManifest = {
  id: 'memory',
  name: '记忆管理',
  description: '通过 PostgreSQL / pgvector 管理长期、分组与 Session 记忆，并按策略召回和抽取',
  kind: 'plugin',
  version: '0.1.0',
};
