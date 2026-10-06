import type { z } from 'zod';
import type {
  DefaultMemoryConfig,
  MemoryItem,
  MemoryScope,
  MemoryKind,
  MemoryStrategyInfo,
} from '../../../shared/memory';

export interface MemoryDraft {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  evidence: string;
  tags: string[];
}
/** Strategies receive scoped data and bounded model calls, never database connections. */
export interface StrategyTools {
  llm<T>(purpose: 'recall' | 'extract', prompt: string, schema: z.ZodType<T>): Promise<T>;
  search(query: string, limit?: number): Promise<MemoryItem[]>;
  read(id: string): Promise<MemoryItem>;
  signal: AbortSignal;
}
export type MemoryBudgets = Pick<
  DefaultMemoryConfig,
  | 'candidateLimit'
  | 'similarityThreshold'
  | 'recentDays'
  | 'maxItems'
  | 'maxBytes'
  | 'scopeLimits'
  | 'timeoutMs'
  | 'fallback'
>;
export interface RecallInput<C> {
  context: string;
  candidates: MemoryItem[];
  config: C;
  tools: StrategyTools;
}
export interface ExtractionInput<C> {
  context: string;
  config: C;
  tools: StrategyTools;
}
export interface MemoryStrategy<C extends object = Record<string, unknown>> {
  info: MemoryStrategyInfo;
  configSchema: z.ZodType<C>;
  budgets(config: C): MemoryBudgets;
  recall(input: RecallInput<C>): Promise<{ id: string; reason: string }[]>;
  extract(input: ExtractionInput<C>): Promise<MemoryDraft[]>;
}

/** Registration is explicit at build time; settingsKey must name the companion client panel. */
export class MemoryStrategyRegistry {
  private entries = new Map<string, MemoryStrategy<any>>();
  register<C extends object>(strategy: MemoryStrategy<C>) {
    if (!strategy.info.settingsKey) throw new Error('Memory strategy requires a settings UI');
    if (this.entries.has(strategy.info.id)) throw new Error('Duplicate memory strategy');
    strategy.configSchema.parse(strategy.info.defaultConfig);
    this.entries.set(strategy.info.id, strategy);
    return this;
  }
  get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Memory strategy is not registered');
    return entry;
  }
  has(id: string) {
    return this.entries.has(id);
  }
  list() {
    return [...this.entries.values()].map((x) => x.info);
  }
}
