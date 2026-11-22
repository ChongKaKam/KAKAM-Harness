import type { FeatureManifest } from '../../shared/types';

export const manifest: FeatureManifest = {
  id: 'openai-gateway',
  name: 'OpenAI API 转发',
  description: '为开发机签发转发密钥，使用管理员独立配置的 OpenAI API Key 调用官方 API',
  kind: 'plugin',
  version: '0.2.0',
  adminOnly: true,
};
