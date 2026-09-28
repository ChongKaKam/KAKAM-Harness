import { Service, type Context } from 'cordis';
import type { Attachment, ApiMode, ReasoningEffort, MessageUsage } from '../shared/types';
export interface ProviderConnection {
  baseUrl: string;
  apiKey: string;
  apiMode?: ApiMode;
}
export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: Attachment[];
}
export type TokenUsage = MessageUsage;
export type ProviderEvent = { type: 'text'; text: string } | { type: 'usage'; usage: TokenUsage };
export interface ModelAdapter {
  discover(connection: ProviderConnection): Promise<string[]>;
  generate(
    connection: ProviderConnection,
    model: string,
    messages: ProviderMessage[],
    signal: AbortSignal,
    effort?: ReasoningEffort,
  ): AsyncIterable<ProviderEvent>;
}
export class AdapterRegistry extends Service {
  private entries = new Map<string, ModelAdapter>();
  constructor(ctx: Context) {
    super(ctx, 'adapters', true);
  }
  register(id: string, adapter: ModelAdapter) {
    if (this.entries.has(id)) throw new Error(`Adapter already exists: ${id}`);
    this.entries.set(id, adapter);
    return () => {
      this.entries.delete(id);
    };
  }
  get(id: string) {
    const adapter = this.entries.get(id);
    if (!adapter) throw new Error(`Adapter unavailable: ${id}`);
    return adapter;
  }
}
