import type { FeatureManifest } from '../../shared/types';

export const manifest: FeatureManifest = {
  id: 'openai-gateway',
  name: 'OpenAI API 转发',
  description: '为开发机签发转发密钥，通过本站调用已配置的 OpenAI 模型',
  kind: 'plugin',
  version: '0.1.0',
  adminOnly: true,
};
