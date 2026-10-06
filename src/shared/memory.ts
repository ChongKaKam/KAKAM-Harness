import type { Message, User } from './types';

export type MemoryScope = 'user' | 'group' | 'session';
export type MemoryKind =
  'profile' | 'preference' | 'instruction' | 'fact' | 'episode' | 'summary' | 'task';
export type MemoryWriteMode = 'off' | 'confirm' | 'auto';
export interface MemorySource {
  conversationId: string;
  messageId: string;
  hash: string;
  evidence?: string;
}
export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  kind: MemoryKind;
  content: string;
  status: 'active' | 'deleted' | 'superseded' | 'review';
  version: number;
  tags: string[];
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  sources: MemorySource[];
  indexStatus?: 'pending' | 'ready' | 'error';
  similarity?: number;
  selection?: 'prefer';
}
export interface MemoryPreferences {
  enabled: boolean;
  strategyId: string;
  embeddingModelId: string | null;
  recallModelId: string | null;
  extractModelId: string | null;
  writeModes: Record<MemoryScope, MemoryWriteMode>;
  retentionDays: { group: number; session: number };
}
export interface DefaultMemoryConfig {
  candidateLimit: number;
  similarityThreshold: number;
  recentDays: number;
  maxItems: number;
  maxBytes: number;
  scopeLimits: Record<MemoryScope, number>;
  timeoutMs: number;
  fallback: 'vector' | 'skip';
  recallPrompt: string;
  extractPrompt: string;
}
export interface MemoryStrategyInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  configVersion: number;
  capabilities: string[];
  settingsKey: string;
  defaultConfig: Record<string, unknown>;
}
export interface MemoryContextBlock {
  memoryId: string;
  version: number;
  scope: MemoryScope;
  content: string;
  reason: string;
}
export interface MemoryPreparation {
  operationId: string | null;
  strategyId: string;
  strategyVersion: string;
  configVersion?: number;
  status: 'skipped' | 'ready' | 'degraded' | 'error';
  blocks: MemoryContextBlock[];
  durationMs: number;
  error: string | null;
  omittedIds: string[];
  timings?: { embeddingMs: number; searchMs: number; selectionMs: number; validationMs: number };
}
/** Offsets into the actual final user message. Decorations belong to their block. */
export interface MemoryContextRange {
  start: number;
  end: number;
  block: MemoryContextBlock;
}
export interface MemoryProposal {
  id: string;
  scope: MemoryScope;
  scopeId: string | null;
  kind: MemoryKind;
  content: string;
  sources: MemorySource[];
  state: 'pending' | 'approved' | 'rejected' | 'invalidated';
  createdAt: string;
  expiresAt: string | null;
  memoryId?: string | null;
}
export interface MemoryScopeState {
  summary: string;
  revision: number;
  selections: Record<string, 'prefer' | 'exclude'>;
  updatedAt: string;
}
export interface MemoryOperation {
  id: string;
  type: string;
  state: 'running' | 'prepared' | 'applied' | 'complete' | 'error' | 'cancelled';
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  facts: Record<string, unknown>;
}
export interface MemoryIndexSpace {
  id: string;
  modelId: string;
  dimensions: number;
  fingerprint: string;
  state: 'building' | 'active' | 'retired' | 'error';
  createdAt: string;
  indexed?: number;
  total?: number;
}
export interface MemoryStatus {
  configured: boolean;
  ready: boolean;
  error: string | null;
  spaces: MemoryIndexSpace[];
}
export interface MemoryTurnInput {
  user: User;
  conversationId: string;
  messageId: string;
  groupId: string | null;
  history: Message[];
  current: string;
  signal: AbortSignal;
}
export interface MemoryCompletedTurn extends Omit<MemoryTurnInput, 'signal'> {
  response: Message;
  signal?: AbortSignal;
}
