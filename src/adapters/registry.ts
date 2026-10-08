import { Service, type Context } from 'cordis';
import type {
  Attachment,
  ApiMode,
  ReasoningEffort,
  MessageUsage,
  EmbeddingResult,
  EmbeddingUsage,
} from '../shared/types';
import type { ProviderDiagnostics } from './diagnostics';
export interface ProviderConnection {
  baseUrl: string;
  apiKey: string;
  apiMode?: ApiMode;
  diagnostics?: ProviderDiagnostics;
}
export interface ProviderMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: Attachment[];
}
export type TokenUsage = MessageUsage;
export interface ImageGenerationResult {
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  usage: EmbeddingUsage | null;
}
export type ProviderEvent = { type: 'text'; text: string } | { type: 'usage'; usage: TokenUsage };
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ToolTurn {
  calls: ToolCall[];
  continuation: unknown[];
}
export interface ToolStep {
  turn: ToolTurn;
  results: { id: string; output: string }[];
}
export type ToolEvent = ProviderEvent | { type: 'turn'; turn: ToolTurn };
export interface DecisionInput {
  state: string;
  instructions: string;
}
export type DecisionEvent =
  { type: 'decision'; enabled: boolean } | { type: 'usage'; usage: TokenUsage };
export interface ModelAdapter {
  generateImage?(
    connection: ProviderConnection,
    model: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ImageGenerationResult>;
  embed?(
    connection: ProviderConnection,
    model: string,
    inputs: string[],
    signal: AbortSignal,
    dimensions?: number,
  ): Promise<EmbeddingResult>;
  generateTurn?(
    connection: ProviderConnection,
    model: string,
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    steps: ToolStep[],
    signal: AbortSignal,
    effort?: ReasoningEffort,
  ): AsyncIterable<ToolEvent>;
  decide?(
    connection: ProviderConnection,
    model: string,
    input: DecisionInput,
    signal: AbortSignal,
  ): AsyncIterable<DecisionEvent>;
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
