import { useState } from 'react';
import type { ProductionMode } from './types';

// Composer choices stay local to this account and chat, rather than becoming an account default.
export function useProductionMode(userId: string, conversationId?: string) {
  const [choices, setChoices] = useState<Record<string, ProductionMode>>({});
  const key = `${userId}:${conversationId ?? 'draft'}`;
  return {
    mode: choices[key] ?? 'auto',
    setMode(mode: ProductionMode, destinationId = conversationId) {
      const destinationKey = `${userId}:${destinationId ?? 'draft'}`;
      setChoices((current) => ({ ...current, [destinationKey]: mode }));
    },
  };
}
