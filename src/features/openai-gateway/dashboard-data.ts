import { z } from 'zod';
import type { Database } from '../../kernel/database';
import type {
  GatewayDashboard,
  GatewayDashboardDays,
  GatewayDashboardMetrics,
} from './dashboard-types';

const dayCounts = { '7': 7, '30': 30, '90': 90 } as const;
export const dashboardQuery = z.strictObject({
  days: z
    .enum(['7', '30', '90'])
    .default('7')
    .transform((days) => dayCounts[days]),
});

// A period and a UTC day use the same sample definitions. NULL token sums mean
// nothing was reported; SUM includes genuine zeros.
const aggregates = `
  COUNT(*) AS calls,
  COUNT(*) FILTER (WHERE status='complete') AS succeeded,
  COUNT(*) FILTER (WHERE status='error') AS failed,
  COUNT(*) FILTER (WHERE status='cancelled') AS cancelled,
  SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
  SUM(total_tokens) AS totalTokens, COUNT(total_tokens) AS tokenSamples,
  SUM(cached) AS cachedInputTokens,
  SUM(input_tokens) FILTER (WHERE cached IS NOT NULL) AS cacheSampleInputTokens,
  COUNT(cached) AS cacheSamples,
  AVG(success_ms) AS averageDurationMs, COUNT(success_ms) AS durationSamples`;

type Counts = Omit<GatewayDashboardMetrics, 'successRate' | 'cacheHitRate'>;

function withRates(metrics: Counts): GatewayDashboardMetrics {
  return {
    ...metrics,
    successRate: metrics.calls ? (100 * metrics.succeeded) / metrics.calls : null,
    cacheHitRate:
      metrics.cacheSampleInputTokens && metrics.cachedInputTokens !== null
        ? (100 * metrics.cachedInputTokens) / metrics.cacheSampleInputTokens
        : null,
  };
}

export function readGatewayDashboard(
  db: Database,
  userId: string,
  days: GatewayDashboardDays,
): GatewayDashboard {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  const since = today.getTime() - (days - 1) * dayMs;
  const until = today.getTime() + dayMs;

  const samples = `WITH samples AS (
    SELECT substr(u.created_at,1,10) AS day, u.status, u.input_tokens, u.output_tokens, u.total_tokens,
      CASE WHEN m.cached_input_tokens BETWEEN 0 AND u.input_tokens THEN m.cached_input_tokens END AS cached,
      CASE WHEN u.status='complete' THEN m.duration_ms END AS success_ms
    FROM usage u JOIN openai_gateway_metrics m ON m.usage_id=u.id
    WHERE u.user_id=? AND u.created_at>=? AND u.created_at<?
      AND u.status IN ('complete','error','cancelled')
  )`;
  // Also aggregate an empty set for calendar days with no calls. This preserves
  // the distinction between zero calls and an unknown token count.
  const rows = db.all<Counts & { day: string }>(
    `${samples}
      SELECT day, ${aggregates} FROM samples GROUP BY day
      UNION ALL SELECT 'total', ${aggregates} FROM samples
      UNION ALL SELECT 'empty', ${aggregates} FROM samples WHERE 0`,
    userId,
    new Date(since).toISOString(),
    new Date(until).toISOString(),
  );
  const buckets = new Map(rows.map(({ day, ...counts }) => [day, withRates(counts)]));
  const daily = Array.from({ length: days }, (_, offset) => {
    const day = new Date(since + offset * dayMs).toISOString().slice(0, 10);
    return { day, ...(buckets.get(day) ?? buckets.get('empty')!) };
  });
  return { days, totals: buckets.get('total')!, daily };
}
