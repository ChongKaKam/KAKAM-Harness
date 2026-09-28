import { test, expect, type Page } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';
import { fontSizes } from '../../src/shared/typography';
import type { Model } from '../../src/shared/types';

async function pointerDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  touch: boolean,
) {
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...from, id: 1 }],
    });
    for (let i = 1; i <= 14; i++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: from.x + ((to.x - from.x) * i) / 14, y: from.y + ((to.y - from.y) * i) / 14, id: 1 },
        ],
      });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 20 });
    await page.mouse.up();
  }
}

test('Anthropic provider, platform link, smooth model reordering/default and persisted reply usage', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  await page.goto('/#/settings/models');
  const suffix = info.project.name;
  const sourceName = `Anthropic ${suffix}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '添加来源', exact: true }).click();
  await page.getByLabel('来源名称').fill(sourceName);
  await page.getByLabel('Base URL', { exact: true }).fill('http://127.0.0.1:3211/v1');
  await page.getByLabel('API Key', { exact: true }).fill('fixture-anthropic');
  await page.getByLabel('平台链接（可选）').fill('https://console.example.test/settings');
  await page.getByLabel('响应模式').selectOption('anthropic-messages');
  await page.getByRole('dialog').getByRole('button', { name: '探测模型' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('发现 2 个模型');
  await page.getByRole('button', { name: '保存来源' }).click();
  await expect(page.getByRole('dialog')).toContainText('探测结果');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const card = page.locator('.provider-card').filter({ hasText: sourceName });
  const platform = card.getByRole('link', { name: '访问平台' });
  await expect(platform).toHaveAttribute('href', 'https://console.example.test/settings');
  await expect(platform).toHaveAttribute('rel', 'noopener noreferrer');
  await card.getByRole('button', { name: `编辑 ${sourceName}` }).click();
  await expect(page.getByLabel('平台链接（可选）')).toHaveValue(
    'https://console.example.test/settings',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  const providers = await (await page.request.get('/api/admin/providers')).json();
  const provider = providers.find((p: { name: string }) => p.name === sourceName);
  const ids: string[] = [];
  try {
    for (const [name, label] of [
      ['test-vision', '视觉模型'],
      ['test-text', '文本模型'],
      ['no-usage', '未上报模型'],
    ]) {
      const res = await page.request.post('/api/admin/models', {
        data: { providerId: provider.id, name, label: `${label} ${suffix}`, vision: true },
      });
      expect(res.ok()).toBe(true);
      ids.push((await res.json()).id);
    }
    const all: Model[] = await (await page.request.get('/api/admin/models')).json();
    const order = [...ids, ...all.filter((m) => !ids.includes(m.id)).map((m) => m.id)];
    expect(
      (await page.request.patch('/api/admin/models/order', { data: { modelIds: order } })).ok(),
    ).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: /模型管理与授权/ }).click();
    const rows = page.locator('.models-sort-panel tbody tr');
    await expect(rows.first()).toHaveAttribute('data-model-id', ids[0]);
    await expect(rows.first().getByText('默认模型')).toBeVisible();
    await rows.first().getByRole('button', { name: '管理', exact: true }).click();
    await page.getByRole('button', { name: '测试连通性' }).click();
    await expect(page.locator('.models-probe-result')).toContainText(
      '连接成功 · Anthropic Messages',
    );
    await expect(page.locator('.models-probe-metrics')).toContainText('65');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const firstHandle = rows.nth(0).getByRole('button', { name: /拖动排序/ });
    await firstHandle.scrollIntoViewIfNeeded();
    const first = (await firstHandle.boundingBox())!;
    const second = (await rows.nth(1).boundingBox())!;
    await pointerDrag(
      page,
      { x: first.x + first.width / 2, y: first.y + first.height / 2 },
      { x: first.x + first.width / 2, y: second.y + second.height / 2 },
      suffix === 'mobile',
    );
    await expect
      .poll(async () => (await (await page.request.get('/api/models')).json())[0].id)
      .toBe(ids[1]);
    await expect(rows.first()).toHaveAttribute('data-model-id', ids[1]);
    await expect(rows.first().getByText('默认模型')).toBeVisible();
    await expect(page.locator('.models-sort-panel')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.models-sort-overlay')).toHaveCount(0);
    // Keyboard ordering remains available without a pointing device.
    const secondHandle = rows.nth(1).getByRole('button', { name: /拖动排序/ });
    await secondHandle.focus();
    await secondHandle.press('Space', { delay: 40 });
    await expect(page.locator('.models-sort-overlay')).toBeVisible();
    await secondHandle.press('ArrowUp');
    await expect(page.locator('[id^="DndLiveRegion"]').last()).toContainText('第 1 位');
    await secondHandle.press('Space', { delay: 40 });
    await expect
      .poll(async () => (await (await page.request.get('/api/models')).json())[0].id)
      .toBe(ids[0]);
    await expect(page.locator('.models-sort-overlay')).toHaveCount(0);
    // Failed writes roll back; no misleading default is left in the UI.
    await page.route('**/api/admin/models/order', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: '模型列表已变化，请刷新后重新排序' }),
      }),
    );
    await expect(page.locator('.models-sort-panel')).toHaveAttribute('aria-busy', 'false');
    const handle = rows.nth(0).getByRole('button', { name: /拖动排序/ });
    await handle.focus();
    await handle.press('Space', { delay: 40 });
    await handle.press('ArrowDown');
    await expect(page.locator('[id^="DndLiveRegion"]').last()).toContainText('第 2 位');
    await handle.press('Space', { delay: 40 });
    await expect(page.getByRole('alert')).toContainText('模型列表已变化');
    await expect(rows.first()).toHaveAttribute('data-model-id', ids[0]);
    await page.unroute('**/api/admin/models/order');
    await page.reload();
    await page.getByRole('button', { name: /模型管理与授权/ }).click();
    await expect(rows.first()).toHaveAttribute('data-model-id', ids[0]);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({ path: `test-results/model-order-${suffix}.png`, fullPage: true });
    await page.goto('/#/chat');
    await expect(page.getByRole('button', { name: /^模型与思考程度/ })).toContainText(
      `视觉模型 ${suffix}`,
    );
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('你好');
    await page.getByRole('button', { name: '发送消息' }).click();
    const usage = page.getByRole('button', { name: 'Token 消耗', exact: true });
    await expect(usage).toHaveText('65 tokens');
    if (suffix === 'desktop') {
      await usage.hover();
      await expect(page.getByRole('tooltip')).toBeVisible();
      await page.getByRole('tooltip').hover();
      await expect(page.getByRole('tooltip')).toBeVisible();
      await page.mouse.move(10, 10);
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    }
    await usage.click();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator('dd')).toHaveText(['23', '42', '65']);
    await page.keyboard.press('Escape');
    await expect(tooltip).toHaveCount(0);
    await page.reload();
    await expect(usage).toHaveText('65 tokens');
    // Both themes and all font scales keep tooltip content within the viewport.
    for (const theme of ['light', 'dark']) {
      expect(
        (
          await page.request.patch('/api/preferences', { data: { theme, assistantIcon: null } })
        ).ok(),
      ).toBe(true);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const size of fontSizes) {
        await page.evaluate(
          (scale) => document.documentElement.style.setProperty('--font-scale', String(scale)),
          size.scale,
        );
        await usage.focus();
        await expect(tooltip).toBeVisible();
        const box = (await tooltip.boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
        await page.screenshot({
          path: `test-results/token-usage-${theme}-${size.id}-${suffix}.png`,
        });
        await page.keyboard.press('Escape');
        await usage.blur();
      }
    }
    await chooseModel(page, { id: ids[2] });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('用量缺失');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(usage.last()).toHaveText('用量未上报');
    await usage.last().click();
    await expect(page.getByRole('tooltip')).toContainText('供应商未上报');
    expect(errors).toEqual([]);
  } finally {
    expect(
      (await page.request.delete(`/api/admin/providers/${provider.id}`, { data: {} })).ok(),
    ).toBe(true);
    await page.request.patch('/api/preferences', {
      data: { theme: 'system', assistantIcon: null },
    });
  }
});
