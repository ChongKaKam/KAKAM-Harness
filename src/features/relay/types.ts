export const relayLimits = {
  title: 120,
  content: 100_000,
  attachmentFilename: 255,
  attachmentBytes: 300 * 1024 * 1024,
  attachmentChunkBytes: 8 * 1024 * 1024,
};
export const relayLifetimeMs = 3 * 24 * 60 * 60 * 1000;

export interface RelayAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string | null;
  persistedAt: string | null;
}

export interface RelayUpload {
  id: string;
  cardId: string;
}

export interface RelayUploadProgress {
  received: number;
  attachment?: RelayAttachment;
}

export interface RelayCard {
  id: string;
  title: string;
  content: string;
  colorSlot: number | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  persistedAt: string | null;
  contentExpired: boolean;
  attachments: RelayAttachment[];
}
