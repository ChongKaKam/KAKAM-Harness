import { z } from 'zod';
import { configSchema, defaultConfig, kinds, renderPrompt, scopes } from '../config';
import type { MemoryStrategy } from './types';
import type { DefaultMemoryConfig } from '../../../shared/memory';
import { MemoryStrategyRegistry } from './types';

const selectedSchema = z.object({
  selected: z
    .array(
      z.object({
        id: z.string().uuid(),
        reason: z.string().max(300).default('与本轮请求相关'),
      }),
    )
    .max(120),
});
const extractionSchema = z.object({
  memories: z
    .array(
      z.object({
        scope: z.enum(scopes),
        kind: z.enum(kinds),
        content: z.string().trim().min(1).max(8000),
        evidence: z.string().trim().min(1).max(8000),
        tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
      }),
    )
    .max(12),
});
export const defaultStrategy: MemoryStrategy<DefaultMemoryConfig> = {
  info: {
    id: 'default',
    name: 'Default · LLM + Prompt',
    description: 'pgvector 召回候选，LLM 按 Prompt 选择记忆并抽取新的三层记忆',
    version: '1.0.0',
    configVersion: 1,
    settingsKey: 'default',
    capabilities: ['vector-search', 'llm-selection', 'turn-extraction'],
    defaultConfig: { ...defaultConfig },
  },
  configSchema,
  budgets: (config) => config,
  async recall({ context, candidates, config, tools }) {
    const prompt = renderPrompt(config.recallPrompt, {
      context,
      candidates: JSON.stringify(
        candidates.map(
          ({ id, scope, kind, content, similarity, pinned, updatedAt, selection }) => ({
            id,
            scope,
            kind,
            content,
            similarity,
            pinned,
            updatedAt,
            selection,
          }),
        ),
      ),
      maxItems: String(config.maxItems),
    });
    return (await tools.llm('recall', prompt, selectedSchema)).selected;
  },
  async extract({ context, config, tools }) {
    return (
      await tools.llm('extract', renderPrompt(config.extractPrompt, { context }), extractionSchema)
    ).memories;
  },
};
export const createStrategyRegistry = () => new MemoryStrategyRegistry().register(defaultStrategy);
