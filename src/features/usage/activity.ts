import type { UsageData } from '../../shared/types';
export type ActivityMode = 'daily' | 'weekly' | 'cumulative';
export interface ActivityCell {
  day: string;
  end: string;
  models: Record<string, number>;
  requests: number;
  total: number;
}
const dateKey = (date: Date) => date.toISOString().slice(0, 10);
const dayMs = 86400000;
export function buildActivity(
  rows: UsageData['activity'],
  days: number,
  mode: ActivityMode,
  now = new Date(),
): ActivityCell[] {
  const last = new Date(dateKey(now) + 'T00:00:00Z').getTime();
  const byDay = new Map<string, typeof rows>();
  for (const row of rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
  const cells: ActivityCell[] = [];
  let cumulative: Record<string, number> = {},
    requests = 0;
  for (let time = last - (days - 1) * dayMs; time <= last; time += dayMs) {
    const day = dateKey(new Date(time));
    const cell: ActivityCell = { day, end: day, models: {}, requests: 0, total: 0 };
    for (const row of byDay.get(day) ?? []) {
      cell.models[row.model] = (cell.models[row.model] ?? 0) + row.total;
      cell.requests += row.requests;
    }
    if (mode === 'cumulative') {
      for (const [model, total] of Object.entries(cell.models))
        cumulative[model] = (cumulative[model] ?? 0) + total;
      requests += cell.requests;
      cell.models = { ...cumulative };
      cell.requests = requests;
    }
    cell.total = Object.values(cell.models).reduce((a, b) => a + b, 0);
    if (mode === 'weekly' && cells.length && new Date(time).getUTCDay() !== 1) {
      const week = cells.at(-1)!;
      for (const [model, total] of Object.entries(cell.models))
        week.models[model] = (week.models[model] ?? 0) + total;
      week.total += cell.total;
      week.requests += cell.requests;
      week.end = day;
    } else cells.push(cell);
  }
  return cells;
}
