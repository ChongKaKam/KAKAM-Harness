import { useWorkspace } from '../../client/context';
import type { ProductionMode } from './types';

// Composer choices stay local to this account and chat, rather than becoming an account default.
export function useProductionMode(userId: string, conversationId?: string) {
  const { user, chatDraft, setChatDraft } = useWorkspace();
  return {
    mode: chatDraft.productionMode,
    setMode(mode: ProductionMode, destinationId = conversationId) {
      if (user.id !== userId) return;
      setChatDraft((current) => ({ ...current, productionMode: mode }), destinationId ?? null);
    },
  };
}
