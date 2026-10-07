import type { MemoryKind, MemoryScope } from '../../shared/memory';
export const scopeLabels: Record<MemoryScope, string> = {
  user: '长期记忆',
  group: '分组记忆',
  session: 'Session 记忆',
};
export const kindLabels: Record<MemoryKind, string> = {
  profile: '画像',
  preference: '偏好',
  instruction: '指令',
  fact: '事实',
  episode: '经历',
  summary: '摘要',
  task: '任务',
};
export const memoryDate = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false });
