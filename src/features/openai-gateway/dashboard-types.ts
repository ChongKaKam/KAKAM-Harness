export type GatewayDashboardDays = 7 | 30 | 90;

export interface GatewayDashboardMetrics {
  calls: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenSamples: number;
  cachedInputTokens: number | null;
  cacheSampleInputTokens: number | null;
  cacheSamples: number;
  cacheHitRate: number | null;
  averageDurationMs: number | null;
  durationSamples: number;
}

export interface GatewayDashboard {
  days: GatewayDashboardDays;
  totals: GatewayDashboardMetrics;
  daily: (GatewayDashboardMetrics & { day: string })[];
}
