import type { FeatureManifest } from '../../shared/types';

export const manifest: FeatureManifest = {
  id: 'context-manager',
  name: '上下文管理',
  description: '查看每轮实际上下文、追踪意图变化，并生成 Agent 交接文档',
  kind: 'plugin',
  version: '0.1.0',
};
