import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';
import { fontSizes } from '../../src/shared/typography';

test('late artifact lists from a previous account never enter the next account workspace', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const password = 'Browser-test-password-123';
  const email = `production-private-${info.project.name}-${Date.now()}@example.test`;
  expect(
    (
      await request.post('/api/admin/users', {
        data: { email, displayName: '独立产物账户', password, role: 'user' },
      })
    ).ok(),
  ).toBe(true);
  // Keep the shared fixture session valid when this test explicitly signs out.
  expect(
    (
      await request.post('/api/auth/login', {
        data: { email: 'admin@example.test', password },
      })
    ).ok(),
  ).toBe(true);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  await page.route('**/api/llm-production/artifacts', async (route) => {
    if (!first) return route.continue();
    first = false;
    started();
    await held;
    await route.fulfill({
      json: {
        space: null,
        artifacts: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: '旧账户的私人产物.md',
            mimeType: 'text/markdown',
            size: 12,
            createdAt: new Date().toISOString(),
            expiresAt: null,
            conversationId: null,
            messageId: null,
            groupId: null,
            spaceName: '旧账户空间',
          },
        ],
      },
    });
  });
  try {
    await page.goto('/#/llm-production');
    await requested;
    const menu = page.getByRole('button', { name: '打开导航', exact: true });
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByLabel('邮箱', { exact: true }).fill(email);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '进入工作区', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
    if (await menu.isVisible()) await menu.click();
    await page
      .getByRole('navigation', { name: '工作区', exact: true })
      .getByRole('button', { name: '产物空间', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '还没有产物', exact: true })).toBeVisible();
    const oldResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/llm-production/artifacts') && response.status() === 200,
    );
    release();
    await oldResponse;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator('.llm-production-item')).toHaveCount(0);
    await expect(page.getByText('旧账户的私人产物.md', { exact: true })).toHaveCount(0);
  } finally {
    release();
    await page.unroute('**/api/llm-production/artifacts');
    await useFixtureSession(page);
  }
});

test('chat artifacts generate, download, share group space, manage and configure across themes', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const preferences = await (await request.get('/api/llm-production/settings')).json();
  const uiPreferences = await (await request.get('/api/preferences')).json();
  const user = (await (await request.get('/api/auth/me')).json()).user;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `产物测试 ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
      },
    })
  ).json();
  const model = await (
    await request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'production-tool',
        label: `产物模型 ${info.project.name}`,
        toolCalling: true,
      },
    })
  ).json();
  const imageModel = await (
    await request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'production-image',
        label: `产物图片模型 ${info.project.name}`,
        kind: 'image',
      },
    })
  ).json();
  const group = await (
    await request.post('/api/conversation-groups', {
      data: { name: `产物分组 ${info.project.name}`, icon: 'folder' },
    })
  ).json();
  const conversation = await (await request.post('/api/conversations', { data: {} })).json();
  const otherConversation = await (await request.post('/api/conversations', { data: {} })).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await request.patch('/api/llm-production/preferences', {
      data: { ...preferences.preferences, enabled: true, temporaryRetentionDays: 7 },
    });
    await page.goto('/#/chat');
    const trigger = page.getByRole('button', { name: '查看当前聊天产物', exact: true });
    await expect(trigger).toBeDisabled();
    await page.goto(`/#/chat/${conversation.id}`);
    await trigger.click();
    const drawer = page.getByRole('dialog', { name: '聊天产物空间', exact: true });
    await expect(drawer.getByRole('heading', { name: '还没有产物' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await chooseModel(page, { id: model.id });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('生成一个 Markdown 文件');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const file = page.getByRole('link', { name: /^下载 测试产物\.md/ });
    await expect(file).toBeVisible();
    await expect(page.locator('.message.assistant').last()).toContainText(
      '已生成产物：测试产物.md',
    );
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    const downloadPromise = page.waitForEvent('download');
    await file.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('测试产物.md');
    expect(await readFile((await download.path())!, 'utf8')).toContain(
      '这是模型通过受控工具生成的 Markdown 文件',
    );
    await page.reload();
    await expect(file).toBeVisible();
    await trigger.click();
    await expect(drawer.locator('.llm-production-space-summary')).toContainText('到期自动清理');
    await expect(drawer.locator('.llm-production-item')).toContainText('测试产物.md');
    await page.keyboard.press('Escape');
    await request.patch(`/api/conversations/${conversation.id}`, { data: { groupId: group.id } });
    await request.patch(`/api/conversations/${otherConversation.id}`, {
      data: { groupId: group.id },
    });
    await page.goto(`/#/chat/${otherConversation.id}`);
    await trigger.click();
    await expect(drawer.locator('.llm-production-space-summary')).toContainText(
      '分组共享 · 默认不过期',
    );
    await expect(drawer.locator('.llm-production-item')).toContainText('测试产物.md');
    await page.keyboard.press('Escape');
    for (const theme of ['light', 'dark']) {
      await request.patch('/api/preferences', { data: { ...uiPreferences, theme } });
      await page.reload();
      await page.evaluate(({ id, size }) => localStorage.setItem(`drift:font-size:${id}`, size), {
        id: user.id,
        size: 'large',
      });
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await trigger.click();
      await expect(drawer.locator('.llm-production-item')).toBeVisible();
      const bounds = (await drawer.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(-1);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      expect(
        await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`production-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await page.goto(`/#/chat/${conversation.id}`);
      await expect(file).toBeVisible();
      const headerBounds = (await trigger.boundingBox())!;
      expect(headerBounds.x + headerBounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await page.screenshot({ path: test.info().outputPath(`production-chat-${theme}.png`) });
      await page.goto('/#/llm-production');
      await page.getByRole('button', { name: `筛选分组 ${group.name}`, exact: true }).click();
      await page.getByRole('button', { name: '管理分组产物', exact: true }).click();
      await expect(page.locator('.llm-production-item')).toContainText('测试产物.md');
      await page.screenshot({
        path: test.info().outputPath(`production-manager-${theme}.png`),
        fullPage: true,
      });
      await page.goto(`/#/chat/${otherConversation.id}`);
    }
    await page.goto('/#/llm-production');
    await expect(page.getByRole('heading', { name: '产物空间', exact: true })).toBeVisible();
    await page.getByRole('button', { name: `筛选分组 ${group.name}`, exact: true }).click();
    await page.getByRole('button', { name: '管理分组产物', exact: true }).click();
    await expect(page.locator('.llm-production-item')).toContainText('测试产物.md');
    await page.getByRole('searchbox', { name: '搜索产物名称' }).fill('没有这个文件');
    await expect(page.getByRole('heading', { name: '没有匹配的产物' })).toBeVisible();
    await page.getByRole('searchbox', { name: '搜索产物名称' }).fill('');
    await page.getByRole('button', { name: '产物设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '产物设置', exact: true })).toBeVisible();
    await page.getByLabel('临时产物保留天数').selectOption('3');
    await page.getByLabel('图片模型', { exact: true }).selectOption(imageModel.id);
    await page.getByRole('checkbox', { name: '允许模型在聊天中生成文件与图片' }).uncheck();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('产物设置已保存');
    await page.reload();
    await expect(page.getByLabel('临时产物保留天数')).toHaveValue('3');
    await expect(page.getByLabel('图片模型', { exact: true })).toHaveValue(imageModel.id);
    await expect(
      page.getByRole('checkbox', { name: '允许模型在聊天中生成文件与图片' }),
    ).not.toBeChecked();
    await expect(page.getByRole('progressbar', { name: '产物存储使用比例' })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath('production-settings.png'),
      fullPage: true,
    });
    // Revalidate a cached model selection when authorization changes in another session.
    expect(
      (
        await request.patch(`/api/admin/models/${imageModel.id}`, {
          data: {
            enabled: false,
            vision: false,
            label: `产物图片模型 ${info.project.name}`,
            userIds: [],
          },
        })
      ).ok(),
    ).toBe(true);
    await page.getByLabel('临时产物保留天数').selectOption('4');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(
      page.getByLabel('图片模型', { exact: true }).locator('option:checked'),
    ).toContainText('原图片模型已停用或未授权');
    await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
    await page.getByLabel('图片模型', { exact: true }).selectOption('');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('产物设置已保存');
    for (const size of fontSizes) {
      await page.evaluate(
        (size) => document.documentElement.style.setProperty('--font-scale', String(size.scale)),
        size,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
    }
    await page.goto(`/#/chat/${conversation.id}`);
    await expect(file).toBeVisible();
    await trigger.click();
    await drawer.getByRole('button', { name: '删除 测试产物.md', exact: true }).click();
    const confirmation = drawer.getByRole('region', { name: '确认删除产物' });
    await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(drawer.locator('.llm-production-item')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '刷新', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(file).toHaveCount(0);
    await page.goto('/#/llm-production');
    await expect(page.getByRole('heading', { name: '还没有产物', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await request.patch('/api/llm-production/preferences', { data: preferences.preferences });
    await request.patch('/api/preferences', { data: uiPreferences });
    await page.evaluate((id) => localStorage.removeItem(`drift:font-size:${id}`), user.id);
    await request.delete(`/api/conversations/${conversation.id}`, { data: {} });
    await request.delete(`/api/conversations/${otherConversation.id}`, { data: {} });
    await request.delete(`/api/conversation-groups/${group.id}`, { data: {} });
    await request.delete(`/api/admin/providers/${provider.id}`, { data: {} });
  }
});
