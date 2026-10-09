export type ProductionFormat =
  'text' | 'markdown' | 'json' | 'csv' | 'html' | 'svg' | 'pdf' | 'docx' | 'xlsx' | 'pptx';

export type ProductionMode = 'auto' | 'required';

export interface ProductionDeliveryItem {
  id: string;
  kind: 'file' | 'image';
  format: ProductionFormat | null;
  name: string;
  brief: string;
  artifactId?: string;
  status: 'pending' | 'complete' | 'failed';
  error?: string;
}

export interface ProductionDelivery {
  decision: 'deliver' | 'clarify';
  items: ProductionDeliveryItem[];
  question?: string;
}

export interface ProductionPreferences {
  enabled: boolean;
  temporaryRetentionDays: number;
  imageModelId: string | null;
}

export interface ProductionArtifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  expiresAt: string | null;
  conversationId: string | null;
  messageId: string | null;
  groupId: string | null;
  spaceName: string;
  deliveryItemId?: string | null;
}

export interface ProductionSpace {
  id: string;
  kind: 'conversation' | 'group' | 'orphan';
  name: string;
  artifactCount: number;
  size: number;
}

export interface ProductionList {
  artifacts: ProductionArtifact[];
  space: ProductionSpace | null;
}

export interface ProductionStorage {
  usedBytes: number;
  limitBytes: number;
  maxFileBytes: number;
}

export interface ProductionSettings {
  preferences: ProductionPreferences;
  storage: ProductionStorage;
}

/** Global per-account quota, managed only by administrators. */
export interface ProductionAdminSettings {
  accountLimitMiB: number;
}

export const productionLimits = {
  fileBytes: 20 * 1024 * 1024,
  accountBytes: 1024 * 1024 * 1024,
  minAccountMiB: 20,
  maxAccountMiB: 1024 * 1024,
  textCharacters: 500_000,
  deliveryItems: 12,
} as const;
