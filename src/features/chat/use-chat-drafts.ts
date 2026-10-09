import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { Attachment } from '../../shared/types';
import type { ProductionMode } from '../llm-production/types';

export interface ChatDraft {
  content: string;
  images: Attachment[];
  productionMode: ProductionMode;
  editing?: {
    id: string;
    previousDraft: string;
    previousImages: Attachment[];
    previousProductionMode: ProductionMode;
  };
}
export const emptyChatDraft: ChatDraft = { content: '', images: [], productionMode: 'auto' };
export type SetChatDraft = (
  update: SetStateAction<ChatDraft>,
  conversationId?: string | null,
) => void;

// Kept in the existing Shell lifetime so leaving the chat page preserves each composer.
export function useChatDrafts(userId?: string, conversationId?: string) {
  const owner = useRef({ userId, revision: 0 });
  if (owner.current.userId !== userId)
    owner.current = { userId, revision: owner.current.revision + 1 };
  const revision = owner.current.revision;
  const [state, setState] = useState<{ userId?: string; drafts: Record<string, ChatDraft> }>({
    userId,
    drafts: {},
  });
  const reset = useCallback(() => {
    owner.current = { ...owner.current, revision: owner.current.revision + 1 };
    setState({ userId: owner.current.userId, drafts: {} });
  }, []);
  useEffect(reset, [userId, reset]);
  const setChatDraft: SetChatDraft = useCallback(
    (update, destinationId = conversationId) => {
      if (!userId || owner.current.userId !== userId || owner.current.revision !== revision) return;
      const key = destinationId ?? 'new';
      setState((current) => {
        if (owner.current.userId !== userId || owner.current.revision !== revision) return current;
        const drafts = current.userId === userId ? current.drafts : {};
        const previous = drafts[key] ?? emptyChatDraft;
        const next = typeof update === 'function' ? update(previous) : update;
        if (next === previous) return current;
        const updated = { ...drafts };
        if (next === emptyChatDraft) delete updated[key];
        else updated[key] = next;
        return { userId, drafts: updated };
      });
    },
    [userId, conversationId, revision],
  );
  return {
    chatDraft:
      state.userId === userId
        ? (state.drafts[conversationId ?? 'new'] ?? emptyChatDraft)
        : emptyChatDraft,
    setChatDraft,
    resetChatDrafts: reset,
  };
}
