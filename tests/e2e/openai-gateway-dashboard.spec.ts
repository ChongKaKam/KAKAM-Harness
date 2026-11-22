import { expect, test } from '@playwright/test';
import type {
  GatewayDashboard,
  GatewayDashboardMetrics,
  GatewayDashboardDays,
} from '../../src/features/openai-gateway/dashboard-types';
import { useFixtureSession } from '../e2e-session';

const empty: GatewayDashboardMetrics = {
  calls: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  successRate: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  tokenSamples: 0,
  cachedInputTokens: null,
  cacheSampleInputTokens: null,
  cacheSamples: 0,
  cacheHitRate: null,
  averageDurationMs: null,
  durationSamples: 0,
};
const measured: GatewayDashboardMetrics = {
  calls: 4,
  succeeded: 3,
  failed: 1,
  cancelled: 0,
  successRate: 75,
  inputTokens: 1000,
  outputTokens: 120,
  totalTokens: 1120,
  tokenSamples: 4,
  cachedInputTokens: 720,
  cacheSampleInputTokens: 1000,
  cacheSamples: 4,
  cacheHitRate: 72,
  averageDurationMs: 2000,
  durationSamples: 3,
};

function fixture(days: GatewayDashboardDays): GatewayDashboard {
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date();
    const daysAgo = days - i - 1;
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return { day: date.toISOString().slice(0, 10), ...(daysAgo === 10 ? measured : empty) };
  });
  return { days, totals: days > 10 ? measured : empty, daily };
}

test('gateway dashboard opens from usage, changes period and handles empty and measured days', async ({
  page,
}) => {
  await useFixtureSession(page);
  let requests = 0;
  await page.route('**/api/admin/openai-gateway/dashboard?*', (route) => {
    requests++;
    const days = Number(
      new URL(route.request().url()).searchParams.get('days'),
    ) as GatewayDashboardDays;
    return route.fulfill({ json: fixture(days) });
  });
  await page.goto('/#/usage');
  await page.getByRole('radio', { name: 'OpenAI 转发看板' }).click();
  await expect(page.getByRole('heading', { name: 'OpenAI 转发看板', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '这段时间没有转发调用' })).toBeVisible();
  await page.getByRole('combobox', { name: '看板时间范围' }).selectOption('30');
  for (const [metric, value] of [
    ['缓存命中率', '72%'],
    ['调用成功率', '75%'],
    ['平均返回时间', '2 秒'],
    ['Token 消耗', '1,120'],
  ]) {
    const card = page
      .locator('.gateway-dashboard-metric')
      .filter({ has: page.getByText(metric, { exact: true }) });
    await expect(card.getByText(value, { exact: true })).toBeVisible();
  }
  await page.getByRole('combobox', { name: '趋势指标' }).selectOption('cacheHitRate');
  await page.getByText('查看逐日明细', { exact: true }).click();
  const detail = page.getByRole('table', { name: '转发调用逐日明细' });
  const measuredDay = fixture(30).daily.find((day) => day.calls > 0)!;
  const measuredRow = detail.getByRole('row').filter({
    has: page.getByRole('rowheader', { name: measuredDay.day }),
  });
  await expect(measuredRow.getByRole('cell', { name: '72%', exact: true })).toBeVisible();
  const previous = requests;
  const refresh = page.getByRole('button', { name: '刷新', exact: true });
  await refresh.click();
  await expect.poll(() => requests).toBeGreaterThan(previous);
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole('combobox', { name: '趋势指标' })).toHaveValue('cacheHitRate');
  await expect(measuredRow.getByRole('cell', { name: '72%', exact: true })).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await page.getByRole('radio', { name: '全部用量' }).click();
  await expect(page.getByRole('combobox', { name: '统计时间范围' })).toBeVisible();
});
