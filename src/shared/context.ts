import type { MessageUsage } from './types';

export interface ContextCompression {
  status: 'compressed' | 'reused' | 'skipped' | 'error';
  beforeCharacters: number;
  afterCharacters: number;
  compressedMessages: number;
  retainedMessages: number;
  threshold: number;
  modelName: string | null;
  durationMs: number;
  usage: MessageUsage | null;
  error: string | null;
}

export interface ContextTrajectory {
  generationId: string;
  status: 'pending' | 'ready' | 'error';
  title: string;
  intent: string;
  answerSummary: string;
  modelName: string | null;
  usage: MessageUsage | null;
  createdAt: string;
  error: string | null;
  inputTruncated: boolean;
}
