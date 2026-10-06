import type { ProviderMessage } from '../../adapters/registry';
import type { Message, User } from '../../shared/types';
import type { ContextCompression } from '../../shared/context';
import type { ContextTurn } from './context-observer';

export interface ContextProcessingInput extends ContextTurn {
  messages: ProviderMessage[];
  signal: AbortSignal;
}
export interface ContextProcessingResult {
  messages: ProviderMessage[];
  compression?: ContextCompression;
}
export interface ContextCompletedTurn {
  user: User;
  conversationId: string;
  messageId: string;
  current: string;
  response: Message;
}
/** Optional input processing and post-turn work; the audit observer stays read-only. */
export interface ContextProcessor {
  prepare(input: ContextProcessingInput): Promise<ContextProcessingResult>;
  complete(input: ContextCompletedTurn): Promise<void>;
}
