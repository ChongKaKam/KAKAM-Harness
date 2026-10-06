import type { User } from '../../shared/types';
import type {
  MemoryCompletedTurn,
  MemoryPreparation,
  MemoryScope,
  MemoryTurnInput,
} from '../../shared/memory';

/** Optional trusted provider. Core chat never depends on the memory plugin. */
export interface MemoryProvider {
  prepare(input: MemoryTurnInput): Promise<MemoryPreparation>;
  complete(input: MemoryCompletedTurn): Promise<void>;
  invalidate(user: User, conversationId: string, messageId: string): Promise<void>;
  removeScope(user: User, scope: MemoryScope, scopeId: string): Promise<void>;
  applied?(user: User, operationId: string): Promise<void>;
}
