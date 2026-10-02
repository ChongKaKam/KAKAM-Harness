import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { syntaxConversation } from '../syntax-fixture';

test('context history and selected-turn handoff work in the responsive drawer', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const request = page.context().request;
  const originalPrefs = await (await request.get('/api/preferences')).json();
  const originalContextPrefs = await (await request.get('/api/context-manager/preferences')).json();
  const { user } = await (await request.get('/api/auth/me')).json();
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `Context ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'test',
      },
    })
  ).json();
  const model = await (
    await request.post('/api/admin/models', {
      data: { providerId: provider.id, name: 'test-text', label: `交接模型 ${info.project.name}` },
    })
  ).json();
  const conversation = await (await request.post('/api/conversations', { data: {} })).json();
  try {
    await page.goto('/#/settings/context-manager');
    await page
      .getByRole('combobox', { name: '默认 Hand-off 模型', exact: true })
      .selectOption(model.id);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Hand-off 模型已保存');

    const firstId = randomUUID();
    const secondId = randomUUID();
    for (const [id, content] of [
      [firstId, '先梳理项目目标'],
      [secondId, '现在确认进度与下一步，保留相关文档链接'],
    ]) {
      const response = await request.post(`/api/conversations/${conversation.id}/messages`, {
        data: { requestId: id, modelId: model.id, content },
      });
      expect(response.ok()).toBe(true);
      await expect
        .poll(async () => {
          const result = await (await request.get(`/api/conversations/${conversation.id}`)).json();
          return result.messages.find((message: { id: string }) => message.id === id)?.status;
        })
        .toBe('complete');
    }
    await page.goto(`/#/chat/${conversation.id}`);
    const trigger = page
      .locator(`[data-message-id="${secondId}"]`)
      .getByRole('button', { name: '查看本轮上下文', exact: true });
    await trigger.click();
    const drawer = page.getByRole('dialog', { name: '对话上下文', exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.context-manager-commit')).toHaveCount(2);
    await expect(drawer.locator('.context-manager-section')).toHaveCount(4);
    await drawer
      .locator('.context-manager-section')
      .filter({ hasText: 'System prompt' })
      .locator('summary')
      .first()
      .click();
    await expect(
      drawer.locator('.context-manager-section').filter({ hasText: 'System prompt' }),
    ).toContainText('未注入');
    const session = drawer.locator('.context-manager-section').filter({ hasText: 'Session 记忆' });
    await session.locator('summary').first().click();
    await expect(session).toContainText('先梳理项目目标');
    await expect(drawer.locator('.context-manager-totals')).toContainText('UTF-8 字节');
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();

    for (const theme of ['light', 'dark'] as const) {
      await request.patch('/api/preferences', { data: { ...originalPrefs, theme } });
      await page.evaluate(
        (userId) => localStorage.setItem(`drift:font-size:${userId}`, 'large'),
        user.id,
      );
      await page.reload();
      await trigger.click();
      await expect(drawer.locator('.context-manager-section')).toHaveCount(4);
      const bounds = (await drawer.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `test-results/context-manager-${theme}-${info.project.name}.png`,
      });
      await page.keyboard.press('Escape');
    }

    await trigger.click();
    await drawer.locator('.context-manager-commit').filter({ hasText: '先梳理项目目标' }).click();
    const handoff = drawer.getByRole('region', { name: 'Hand-off 交接', exact: true });
    await expect(handoff.getByRole('combobox', { name: 'Hand-off 模型', exact: true })).toHaveValue(
      model.id,
    );
    let handoffCalls = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/handoff') && request.method() === 'POST') handoffCalls++;
    });
    await handoff.getByRole('button', { name: '生成 Hand-off', exact: true }).click();
    await expect(handoff.getByRole('heading', { name: '用户意图轨迹', exact: true })).toBeVisible();
    await handoff.getByRole('button', { name: '复制 Hand-off', exact: true }).click();
    await expect(
      handoff.getByRole('button', { name: '已复制 Hand-off', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('用户意图轨迹');
    const downloading = page.waitForEvent('download');
    await handoff.getByRole('button', { name: '下载 Markdown', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`handoff-${firstId}.md`);
    expect(await readFile((await download.path())!, 'utf8')).toContain('相关文档资料');
    expect(handoffCalls).toBe(1);
    await drawer.locator('.context-manager-commit').filter({ hasText: '现在确认进度' }).click();
    await expect(drawer.getByRole('button', { name: '下载 Markdown', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.goto(`/#/chat/${syntaxConversation}`);
    await page.getByRole('button', { name: '查看本轮上下文', exact: true }).click();
    await expect(drawer.getByText('这一轮没有上下文快照', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/conversations/${conversation.id}`);
    await request.patch('/api/context-manager/preferences', { data: originalContextPrefs });
    await request.delete(`/api/admin/providers/${provider.id}`);
    await request.patch('/api/preferences', { data: originalPrefs });
  }
});
