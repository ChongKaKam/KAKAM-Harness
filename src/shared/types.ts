import type { AccentColor } from './appearance';
export type Role = 'admin' | 'user';
export type ApiMode = 'chat-completions' | 'responses';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
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
  enabled?: boolean;
}
export interface Model {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  label: string;
  vision: boolean;
  enabled: boolean;
}
export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  apiMode: ApiMode;
}
export interface Attachment {
  name: string;
  data: string;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images: Attachment[];
  modelName?: string;
  status: 'complete' | 'error' | 'cancelled' | 'streaming';
  createdAt: string;
}
export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  generating: boolean;
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
  | { type: 'snapshot'; messages: Message[] }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'done'; message: Message }
  | { type: 'error'; message: string };
