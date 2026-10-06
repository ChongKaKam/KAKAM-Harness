import { z } from 'zod';
import type { Database } from '../../kernel/database';
import type { ContextPreferences } from './types';

const modelId = z.string().uuid().nullable();
export const contextPreferencesSchema = z.object({
  handoffModelId: modelId,
  compressionEnabled: z.boolean(),
  compressionModelId: modelId,
  compressionThreshold: z.number().int().min(2000).max(1_000_000),
  compressionKeepTurns: z.number().int().min(1).max(20),
  compressionMaxCharacters: z.number().int().min(500).max(16_000),
  trajectoryEnabled: z.boolean(),
  trajectoryModelId: modelId,
});
export const defaultContextPreferences: ContextPreferences = {
  handoffModelId: null,
  compressionEnabled: false,
  compressionModelId: null,
  compressionThreshold: 24_000,
  compressionKeepTurns: 4,
  compressionMaxCharacters: 6000,
  trajectoryEnabled: false,
  trajectoryModelId: null,
};
export function contextPreferences(db: Database, userId: string): ContextPreferences {
  const saved = db.get<{ handoffModelId: string | null; config: string }>(
    'SELECT handoff_model_id AS handoffModelId,config FROM context_preferences WHERE user_id=?',
    userId,
  );
  return contextPreferencesSchema.parse({
    ...defaultContextPreferences,
    ...JSON.parse(saved?.config ?? '{}'),
    handoffModelId: saved?.handoffModelId ?? null,
  });
}
