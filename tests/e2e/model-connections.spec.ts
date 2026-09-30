import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { fontSizes } from '../../src/shared/typography';

test('compact sources, draft discovery and per-model diagnostics fit themes and font sizes', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const sourceName = `Connections ${info.project.name}`;
  const provider = await (
    await page.request.post('/api/admin/providers', {
      data: {
        name: sourceName,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
        apiMode: 'responses',
        platformUrl: 'https://console.example.test',
      },
    })
  ).json();
  const model = await (
    await page.request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'test-vision',
        label: sourceName,
      },
    })
  ).json();
  try {
    await page.goto('/#/settings/models');
    const card = page.locator('.models-provider-card').filter({ hasText: sourceName });
    await expect(card.getByText('模型列表正常')).toBeVisible();
    await card.getByRole('button', { name: `编辑 ${sourceName}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: '测试连通性' })).toHaveCount(0);
    await dialog.getByRole('button', { name: '探测模型' }).click();
    await expect(dialog.getByRole('status')).toContainText('发现 6 个模型');
    await expect(dialog.getByRole('list', { name: '探测到的模型' })).toContainText('test-vision');
    // Changing the protocol invalidates the old discovery. Cancellation does not persist the draft.
    await dialog.getByLabel('响应模式').selectOption('anthropic-messages');
    await expect(dialog.getByRole('list', { name: '探测到的模型' })).toHaveCount(0);
    await dialog.getByRole('button', { name: '探测模型' }).click();
    await expect(dialog.getByRole('status')).toContainText('发现 2 个模型');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(card).toContainText('Responses');

    for (const theme of ['light', 'dark']) {
      await page.request.patch('/api/preferences', { data: { theme, assistantIcon: null } });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const size of fontSizes) {
        await page.evaluate(
          (scale) => document.documentElement.style.setProperty('--font-scale', String(scale)),
          size.scale,
        );
        await card.scrollIntoViewIfNeeded();
        const box = (await card.boundingBox())!;
        expect(box.height).toBeLessThan(info.project.name === 'desktop' ? 160 : 260);
        expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        if (size.id === 'standard')
          await page.screenshot({
            path: `test-results/compact-sources-${theme}-${info.project.name}.png`,
          });
        await page.getByRole('button', { name: /模型管理与授权/ }).click();
        await page
          .locator(`[data-model-id="${model.id}"]`)
          .getByRole('button', { name: '管理', exact: true })
          .click();
        await dialog.getByLabel('测试思考程度').selectOption('low');
        await dialog.getByRole('button', { name: '测试连通性' }).click();
        await expect(dialog.locator('.models-probe-result')).toContainText('连接成功 · Responses');
        await expect(dialog.locator('.models-probe-metrics dd')).toHaveText([
          /\d+ ms/,
          /\d+ ms/,
          '3',
          '65',
        ]);
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (size.id === 'large')
          await page.screenshot({
            path: `test-results/model-probe-${theme}-${info.project.name}.png`,
          });
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.getByRole('button', { name: /^模型来源/ }).click();
      }
    }
    await card.getByRole('button', { name: `编辑 ${sourceName}` }).click();
    await page.route('**/api/admin/providers/discover', (route) =>
      route.fulfill({ json: { models: [] } }),
    );
    await dialog.getByRole('button', { name: '探测模型' }).click();
    await expect(dialog.getByRole('status')).toContainText('手动添加模型');
    await page.unroute('**/api/admin/providers/discover');
    await page.route('**/api/admin/providers/discover', (route) =>
      route.fulfill({ status: 502, json: { error: '来源暂时不可用' } }),
    );
    await dialog.getByRole('button', { name: '探测模型' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('来源暂时不可用');
    await expect(dialog.getByRole('button', { name: '保存来源' })).toBeEnabled();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  } finally {
    await page.request.delete(`/api/admin/providers/${provider.id}`, { data: {} });
    await page.request.patch('/api/preferences', {
      data: { theme: 'system', assistantIcon: null },
    });
  }
});
