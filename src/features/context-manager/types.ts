import type { Message, MessageUsage } from '../../shared/types';
import type { MemoryPreparation, MemoryScope } from '../../shared/memory';
import type { ContextCompression, ContextTrajectory } from '../../shared/context';

export type ContextSectionId = 'system' | 'long-term' | 'group' | 'session' | 'current';
export interface ContextEntry {
  memoryId?: string;
  memoryVersion?: number;
  memoryScope?: MemoryScope;
  memoryReason?: string;
  memoryDeleted?: boolean;
  label: string;
  role?: 'user' | 'assistant' | 'tool';
  content: string;
  images: { name: string; bytes: number }[];
}
export interface ContextSection {
  id: ContextSectionId;
  label: string;
  description: string;
  entries: ContextEntry[];
  characters: number;
  bytes: number;
  imageCount: number;
}
export interface ContextSummary {
  compression?: ContextCompression;
  trajectory?: ContextTrajectory;
  messageId: string;
  createdAt: string;
  modelName: string;
  status: Message['status'];
  prompt: string;
  replacesMessageId: string | null;
  characters: number;
  bytes: number;
  imageCount: number;
  requestCount: number;
  usage: MessageUsage | null;
}
export interface ContextSnapshot extends ContextSummary {
  /** Recall trace captured before this request; post-turn extraction is fetched separately. */
  memory?: MemoryPreparation;
  sections: ContextSection[];
  response: string;
  error: string | null;
  reasoningEffort: string;
}
export interface ContextPreferences {
  handoffModelId: string | null;
  compressionEnabled: boolean;
  compressionModelId: string | null;
  compressionThreshold: number;
  compressionKeepTurns: number;
  compressionMaxCharacters: number;
  trajectoryEnabled: boolean;
  trajectoryModelId: string | null;
}
export interface ContextHandoff {
  markdown: string;
  usage: MessageUsage | null;
  createdAt: string;
  modelName: string;
  throughMessageId: string;
}
