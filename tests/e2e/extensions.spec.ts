import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';
import { fontSizes } from '../../src/shared/typography';

test('capability settings, Search toggle, sources, Jev selection and responsive themes', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const providerIds: string[] = [];
  const conversations: string[] = [];
  const prefix = `Extensions ${info.project.name}`;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function createModel(mode: string, name: string, baseUrl: string) {
    const provider = await (
      await page.request.post('/api/admin/providers', {
        data: { name: `${prefix} ${mode}`, baseUrl, apiKey: 'fixture', apiMode: mode },
      })
    ).json();
    providerIds.push(provider.id);
    const model = await (
      await page.request.post('/api/admin/models', {
        data: { providerId: provider.id, name, label: `${prefix} ${name}` },
      })
    ).json();
    return model.id as string;
  }
  const llm = await createModel('responses', 'test-text', 'http://127.0.0.1:3211/v1');
  const jev = await createModel('jev', 'jev-latest', 'http://127.0.0.1:3211/jev');
  try {
    await page.goto('/#/settings/extensions');
    await expect(page.getByRole('heading', { name: '拓展能力', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '插件设置' }).click();
    await expect(page.getByRole('heading', { name: 'Search 设置', exact: true })).toBeVisible();
    await page.getByLabel('Search Base URL').fill('http://127.0.0.1:3211');
    await page.getByLabel('Perplexity Search API Key').fill('fixture-search-key');
    await page.getByRole('button', { name: '保存 Search 配置' }).click();
    await expect(page.getByLabel('清除已保存的密钥')).toBeVisible();
    await expect(page.getByLabel('Perplexity Search API Key')).toHaveValue('');
    await page.getByRole('button', { name: '拓展能力', exact: true }).last().click();
    await page.getByRole('button', { name: '能力设置', exact: true }).click();
    await page.getByLabel('Auto 决策方式').selectOption('llm-jev');
    await page.getByLabel('辅助 LLM').selectOption(llm);
    await page.getByLabel('Jev 决策模型').selectOption(jev);
    await page.getByRole('button', { name: '保存能力配置' }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get('/api/admin/extensions')).json())[0].policy.strategy,
      )
      .toBe('llm-jev');
    await page.goto('/#/chat');
    await chooseModel(page, { id: llm });
    const trigger = page.getByRole('button', { name: '添加内容和工具', exact: true });
    const popup = page.getByRole('dialog', { name: '添加内容和工具', exact: true });
    await expect(trigger).toBeEnabled();
    await expect(page.getByRole('radio', { name: 'Auto · 自动判断' })).not.toBeVisible();
    await trigger.click();
    await expect(popup).toBeVisible();
    await expect(popup.getByRole('radio', { name: 'Off · 始终关闭' })).toBeChecked();
    await popup.getByRole('radio', { name: 'On · 始终开启' }).click();
    await expect(popup.getByRole('radio', { name: 'On · 始终开启' })).toBeChecked();
    await popup.getByRole('radio', { name: 'Auto · 自动判断' }).click();
    await expect(popup.getByRole('radio', { name: 'Auto · 自动判断' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    // Management uses the same account preference as the chat popover.
    await page.goto('/#/settings/extensions');
    await expect(page.getByRole('radio', { name: 'Auto · 自动判断' })).toBeChecked();
    const other = await page.context().newPage();
    try {
      await other.goto('/#/chat');
      await other.getByRole('button', { name: '添加内容和工具', exact: true }).click();
      await expect(other.getByRole('radio', { name: 'Auto · 自动判断' })).toBeChecked();
      await page.getByRole('radio', { name: 'Off · 始终关闭' }).click();
      await expect(page.getByRole('radio', { name: 'Off · 始终关闭' })).toBeChecked();
      await expect(other.getByRole('radio', { name: 'Off · 始终关闭' })).toBeChecked();
    } finally {
      await other.close();
    }
    await page.goto('/#/chat');
    await trigger.click();
    await expect(popup.getByRole('radio', { name: 'Off · 始终关闭' })).toBeChecked();
    await popup.getByRole('radio', { name: 'Auto · 自动判断' }).focus();
    await page.keyboard.press('Space');
    await expect(popup.getByRole('radio', { name: 'Auto · 自动判断' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(popup).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('搜索最新信息并提供来源');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const result = page.locator('.extensions-result');
    await expect(result.locator('summary')).toContainText('完成');
    conversations.push(page.url().split('/chat/')[1]);
    await result.locator('summary').click();
    await expect(result).toContainText('Jev 决策');
    await expect(result).toContainText('输入 17 / 输出 3 / 合计 20');
    await expect(result.locator('.extensions-sources a')).toHaveCount(2);
    await expect(result.locator('.extensions-sources a').first()).toHaveAttribute(
      'href',
      'https://example.test/docs',
    );
    await expect(result).toContainText('<script>not executed</script>');
    await page.reload();
    await expect(result.locator('summary')).toContainText('2 个来源');
    await trigger.click();
    await expect(popup.getByRole('radio', { name: 'Auto · 自动判断' })).toBeChecked();
    await page.keyboard.press('Escape');
    for (const theme of ['light', 'dark']) {
      await page.request.patch('/api/preferences', { data: { theme, assistantIcon: null } });
      await page.reload();
      await result.locator('summary').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const size of fontSizes) {
        await page.evaluate((size) => {
          document.documentElement.dataset.fontSize = size.id;
          document.documentElement.style.setProperty('--font-scale', String(size.scale));
        }, size);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        ).toBe(true);
        await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
        await trigger.click();
        await expect(popup).toBeVisible();
        const bounds = await popup.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(await popup.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        if (size.id === 'large')
          await page.screenshot({ path: test.info().outputPath(`extensions-menu-${theme}.png`) });
        await page.keyboard.press('Escape');
      }
      await page.screenshot({
        path: test.info().outputPath(`extensions-${theme}.png`),
        fullPage: true,
      });
    }
    await page.goto('/#/settings/extensions');
    await expect(page.locator('.extensions-list-row').first()).toBeVisible();
    await expect(page.locator('.extensions-page .pattern-card')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath('extensions-settings.png'),
      fullPage: true,
    });
    await page.goto('/#/settings/models');
    await page.getByRole('button', { name: /模型管理与授权/ }).click();
    const row = page.locator(`[data-model-id="${jev}"]`);
    await expect(row).toContainText('Jev 决策');
    await row.getByRole('button', { name: '管理', exact: true }).click();
    await page.getByRole('button', { name: '测试连通性', exact: true }).click();
    await expect(page.locator('.models-probe-result')).toContainText('连接成功');
    await expect(page.locator('.models-probe-result')).toContainText('有效 JSON');
    await page.locator('.models-probe-log summary').click();
    await expect(page.locator('.models-probe-log')).toContainText(
      'The user asks for current news.',
    );
    await expect(page.locator('.models-probe-log')).toContainText('HTTP 200');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const badJev = await createModel('jev', 'jev-error', 'http://127.0.0.1:3211/jev');
    for (const theme of ['light', 'dark']) {
      await page.request.patch('/api/preferences', { data: { theme, assistantIcon: null } });
      await page.reload();
      await page.getByRole('button', { name: /模型管理与授权/ }).click();
      await page
        .locator(`[data-model-id="${badJev}"]`)
        .getByRole('button', { name: '管理', exact: true })
        .click();
      await expect(page.getByLabel('支持图片输入')).not.toBeVisible();
      await page.getByRole('button', { name: '测试连通性', exact: true }).click();
      const log = page.locator('.models-probe-log');
      await expect(log).toHaveAttribute('open', '');
      await expect(log).toContainText('HTTP 401');
      await expect(log).toContainText('Invalid API key');
      await expect(log).toContainText('[REDACTED]');
      await expect(log).not.toContainText('Bearer fixture');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await log.getByRole('heading', { name: '上游响应 · HTTP 401' }).scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`jev-error-${theme}.png`) });
    }
    expect(errors).toEqual([]);
  } finally {
    await page.request.patch('/api/extensions/preferences', { data: { modes: {} } });
    await page.request.patch('/api/admin/extensions/search', {
      data: { enabled: true, strategy: 'llm', llmModelId: null, decisionModelId: null },
    });
    await page.request.patch('/api/admin/search', { data: { apiKey: '' } });
    await page.request.patch('/api/preferences', {
      data: { theme: 'system', assistantIcon: null },
    });
    for (const id of conversations)
      await page.request.delete(`/api/conversations/${id}`, { data: {} });
    for (const id of providerIds)
      await page.request.delete(`/api/admin/providers/${id}`, { data: {} });
  }
});
