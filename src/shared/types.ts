import type { SelectedSkill, SkillRead } from '../features/skills/types';
import type {
  ProductionArtifact,
  ProductionDelivery,
  ProductionMode,
} from '../features/llm-production/types';
import type { AccentColor } from './appearance';
export type Role = 'admin' | 'user';
export type LlmApiMode = 'responses' | 'anthropic-messages';
export type ApiMode = LlmApiMode | 'jev';
export const apiModeLabels: Record<ApiMode, string> = {
  responses: 'Responses',
  'anthropic-messages': 'Anthropic Messages',
  jev: 'Jev · 决策模型',
};
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface UiPreferences {
  theme: 'light' | 'dark' | 'system';
  accentColor: AccentColor;
  colorPattern: string;
  assistantIcon: string | null;
}
export interface User {
  id: string;
  email: string | null;
  legacyUsername?: string;
  displayName: string;
  avatar: string | null;
  role: Role;
  active: boolean;
}
export interface FeatureManifest {
  id: string;
  name: string;
  description: string;
  kind: 'core' | 'plugin';
  version: string;
  adminOnly?: boolean;
  capability?: boolean;
  enabled?: boolean;
}
export interface Model {
  kind: 'llm' | 'jev' | 'embedding' | 'image';
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  label: string;
  vision: boolean;
  toolCalling?: boolean;
  enabled: boolean;
  /** An active legacy LLM was disabled when Chat Completions was retired. */
  needsProtocolReview?: boolean;
  /** Total input and output capacity for this model on its configured endpoint. */
  contextWindowTokens?: number | null;
  /** Output token limit sent to the model. Null uses the adapter's default. */
  maxOutputTokens?: number | null;
  /** Requested embedding dimensions. Null means the provider default. */
  embeddingDimensions?: number | null;
  /** Dimensions returned by the most recent successful validation. */
  validatedDimensions?: number | null;
}
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  apiMode: ApiMode;
  platformUrl: string | null;
  health: { state: 'unknown' | 'checking' | 'ok' | 'error'; checkedAt: string | null };
}
export interface ModelConnectionTest {
  ok: boolean;
  model: string;
  apiMode: ApiMode;
  reasoningEffort: ReasoningEffort;
  /** Server-to-provider measurement, excluding the browser's network latency. */
  firstTextMs: number | null;
  latencyMs: number;
  textChunks: number;
  usage: MessageUsage | EmbeddingUsage | null;
  kind?: Model['kind'];
  configuredDimensions?: number | null;
  actualDimensions?: number | null;
  dimensionsMatch?: boolean | null;
  /** In order: tool selection, then verification of its returned value. Only attempted calls appear. */
  toolRounds?: { ok: boolean; usage: MessageUsage | null }[];
  diagnostics: ModelDiagnosticLog;
  error?: string;
}
export interface EmbeddingUsage {
  input: number | null;
  output: number | null;
  total: number | null;
}
export interface EmbeddingResult {
  vectors: number[][];
  dimensions: number;
  usage: EmbeddingUsage | null;
}
/** Ephemeral, credential-redacted log returned only by the admin connection test. */
export interface ModelDiagnosticLog {
  request?: { method: string; url: string; headers: Record<string, string>; body: string };
  response?: { status: number; headers: Record<string, string>; body: string };
  output: string;
  error?: string;
  truncated: boolean;
}
export interface Attachment {
  name: string;
  data: string;
}
export interface HarnessClarification {
  question: string;
  suggestion?: string;
}
export interface HarnessRun {
  clarification?: HarnessClarification;
  modelId?: string;
  effort?: ReasoningEffort;
  phase: 'prepare' | 'search' | 'answer' | 'verify' | 'waiting' | 'done' | 'error' | 'cancelled';
  detail: string;
  steps: { label: string; status: string }[];
  steering: { id: string; content: string; applied: boolean; receipt?: string }[];
}
export interface Message {
  harnessRun?: HarnessRun;
  artifacts?: ProductionArtifact[];
  productionMode?: ProductionMode;
  productionDelivery?: ProductionDelivery | null;
  skills?: SelectedSkill[];
  skillReads?: SkillRead[];
  calls?: ExtensionCall[];
  extensions?: ExtensionRun[];
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images: Attachment[];
  modelName?: string;
  status: 'complete' | 'error' | 'cancelled' | 'streaming';
  createdAt: string;
  /** Final, provider-reported usage. Null/absent means not reported, never zero. */
  usage?: MessageUsage | null;
  /** Server-measured generation duration, including extensions, wait and generation. Unknown for old messages. */
  durationMs?: number | null;
  /** Safe, persisted reason for an incomplete assistant reply. */
  error?: string | null;
}
export interface MessageUsage {
  input: number;
  output: number;
  total: number;
}
export interface Conversation {
  harness?: boolean;
  id: string;
  title: string;
  updatedAt: string;
  generating: boolean;
  colorSlot: number | null;
  groupId: string | null;
}
export interface ConversationGroup {
  id: string;
  name: string;
  icon: string;
  colorSlot: number | null;
}
export interface UsageRow {
  id: string;
  email: string;
  modelName: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  status: string;
  createdAt: string;
}
export interface UsageData {
  rows: UsageRow[];
  totals: { input: number; output: number; total: number; requests: number; unreported: number };
  daily: { day: string; total: number }[];
  activity: { day: string; model: string; total: number; requests: number }[];
}
export type StreamEvent =
  | {
      type: 'artifacts';
      messageId: string;
      artifacts: ProductionArtifact[];
      productionDelivery?: ProductionDelivery | null;
    }
  | { type: 'skill-progress'; messageId: string; skillReads: SkillRead[]; calls: ExtensionCall[] }
  | { type: 'extensions'; messageId: string; extensions: ExtensionRun[] }
  | { type: 'harness-progress'; messageId: string; run: HarnessRun }
  | { type: 'snapshot'; messages: Message[]; harness?: boolean }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; message: string };

export type ExtensionMode = 'auto' | 'on' | 'off';
export interface ExtensionPolicy {
  enabled: boolean;
  strategy: 'llm' | 'llm-jev';
  llmModelId: string | null;
  decisionModelId: string | null;
}
export interface ExtensionInfo {
  id: string;
  name: string;
  description: string;
  icon: 'globe' | 'puzzle';
  settingsId: string;
  ready: boolean;
  enabled: boolean;
}
export interface ExtensionSource {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}
export interface ExtensionCall {
  id: string;
  stage: string;
  modelName: string;
  status: 'streaming' | 'complete' | 'error' | 'cancelled';
  usage: MessageUsage | null;
}
export interface ExtensionRun {
  warning?: string;
  id: string;
  name: string;
  mode: ExtensionMode;
  status: 'deciding' | 'running' | 'complete' | 'skipped' | 'error' | 'cancelled';
  decision?: { enabled: boolean };
  queries: string[];
  sources: ExtensionSource[];
  calls: ExtensionCall[];
  error?: string;
  /** Auto failed; no result from this capability was injected into the answer. */
  fallback?: 'skip';
}
