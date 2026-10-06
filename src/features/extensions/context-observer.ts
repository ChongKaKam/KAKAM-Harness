import type { ProviderMessage, ToolDefinition } from '../../adapters/registry';
import type { Message, ReasoningEffort, User } from '../../shared/types';
import type { MemoryContextRange, MemoryPreparation } from '../../shared/memory';
import type { ContextCompression } from '../../shared/context';

/** Optional, synchronous audit observer. It never modifies provider input. */
export interface ContextTurn {
  user: User;
  conversationId: string;
  messageId: string;
  modelId: string;
  modelName: string;
  createdAt: string;
  reasoningEffort: ReasoningEffort;
  replacesMessageId?: string;
  history: Message[];
  current: ProviderMessage;
}

export interface ContextRequest {
  compression?: ContextCompression;
  memory?: MemoryPreparation;
  memoryRanges?: MemoryContextRange[];
  callId: string;
  messages: ProviderMessage[];
  tools: ToolDefinition[];
  /** Only visible text/calls/results; opaque provider reasoning is deliberately excluded. */
  steps: {
    text: string;
    calls: { id: string; name: string; arguments: unknown }[];
    results: { id: string; output: string }[];
  }[];
}

export interface ContextRecorder {
  request(input: ContextRequest): void;
  finish(message: Message): void;
}

export interface ContextObserver {
  begin(input: ContextTurn): ContextRecorder;
  /** Removes copied memory text from audit snapshots after a user deletes a memory. */
  redactMemory?(userId: string, memoryId: string): void;
}
