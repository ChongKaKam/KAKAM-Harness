export const relayLimits = { title: 120, content: 100_000 };
export const relayLifetimeMs = 3 * 24 * 60 * 60 * 1000;

export interface RelayCard {
  id: string;
  title: string;
  content: string;
  colorSlot: number | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  persistedAt: string | null;
}
