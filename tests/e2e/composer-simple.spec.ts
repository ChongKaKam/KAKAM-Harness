import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';

test('compact composer keeps optional tools in the add menu and preserves formatting and sending', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const appearance = await (await request.get('/api/preferences')).json();
  const production = await (await request.get('/api/llm-production/preferences')).json();
  const user = (await (await request.get('/api/auth/me')).json()).user;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `简约输入 ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
      },
    })
  ).json();
  const model = await (
    await request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'test-text',
        label: `简约聊天 ${info.project.name}`,
        toolCalling: true,
      },
    })
  ).json();
  const conversation = await (await request.post('/api/conversations', { data: {} })).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const composer = page.locator('.composer');
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  const trigger = page.getByRole('button', { name: '添加内容和工具', exact: true });
  const menu = page.getByRole('dialog', { name: '添加内容和工具', exact: true });
  const toolbar = page.getByRole('toolbar', { name: '文本格式', exact: true });
  const mode = page.getByLabel('产物输出', { exact: true });
  try {
    await request.patch('/api/llm-production/preferences', { data: { enabled: true } });
    await page.goto(`/#/chat/${conversation.id}`);
    await chooseModel(page, { id: model.id });
    await expect(toolbar).not.toBeVisible();
    await expect(mode).not.toBeVisible();
    await expect(page.getByRole('button', { name: '拓展能力', exact: true })).toHaveCount(0);
    await expect(page.locator('.composer-tools').getByRole('button')).toHaveCount(3);
    expect((await composer.boundingBox())!.height).toBeLessThan(220);
    await trigger.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('button', { name: '添加图片', exact: true })).toBeDisabled();
    await expect(menu.getByRole('button', { name: 'Skill 库 插件', exact: true })).toBeEnabled();
    await expect(mode).toHaveValue('auto');
    await mode.click();
    await page.keyboard.press('Escape');
    const selectEscapeLeavesMenuOpen = await menu.isVisible();
    await info.attach('native-select-escape', {
      body: Buffer.from(JSON.stringify({ selectEscapeLeavesMenuOpen })),
      contentType: 'application/json',
    });
    if (selectEscapeLeavesMenuOpen) await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await mode.selectOption('required');
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(
      composer.getByText('必须产物', { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await trigger.click();
    await expect(mode).toHaveValue('required');
    await mode.selectOption('auto');
    await menu.getByRole('checkbox', { name: '显示文本格式', exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(toolbar).toBeVisible();
    await input.fill('精简界面仍能编辑粗体');
    await input.press('ControlOrMeta+A');
    await toolbar.getByRole('button', { name: '插入粗体', exact: true }).click();
    await expect(input.locator('strong')).toHaveText('精简界面仍能编辑粗体');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.message.user .markdown strong')).toHaveText('精简界面仍能编辑粗体');
    await expect(page.getByRole('button', { name: '复制回复', exact: true })).toBeVisible();
    await expect(input).toBeEmpty();
    for (const theme of ['light', 'dark']) {
      await request.patch('/api/preferences', { data: { ...appearance, theme } });
      await page.evaluate((id) => localStorage.setItem(`drift:font-size:${id}`, 'large'), user.id);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(toolbar).not.toBeVisible();
      await expect(mode).not.toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect(
        await composer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`composer-${theme}.png`) });
      await trigger.click();
      await expect(menu).toBeVisible();
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
      await page.screenshot({ path: info.outputPath(`composer-menu-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    }
    expect(errors).toEqual([]);
  } finally {
    await request.patch('/api/preferences', { data: appearance });
    await request.patch('/api/llm-production/preferences', { data: production });
    await request.delete(`/api/conversations/${conversation.id}`);
    await request.delete(`/api/admin/providers/${provider.id}`);
  }
});
