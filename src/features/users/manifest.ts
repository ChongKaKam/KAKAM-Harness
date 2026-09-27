import type { FeatureManifest } from '../../shared/types';
export const manifest: FeatureManifest = {
  id: 'users',
  name: '用户管理',
  description: '管理账户、角色与访问权限',
  kind: 'core',
  version: '0.4.0',
  adminOnly: true,
};
