import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';

test('edit the latest question and retry a failed reply on desktop and mobile', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const sourceName = `Revision ${info.project.name}`;
  const provider = await (
    await page.request.post('/api/admin/providers', {
      data: {
        name: sourceName,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
        apiMode: 'chat-completions',
      },
    })
  ).json();
  const good = await (
    await page.request.post('/api/admin/models', {
      data: { providerId: provider.id, name: 'test-text', label: 'Revision good' },
    })
  ).json();
  const broken = await (
    await page.request.post('/api/admin/models', {
      data: { providerId: provider.id, name: 'broken', label: 'Revision broken' },
    })
  ).json();
  const slow = await (
    await page.request.post('/api/admin/models', {
      data: { providerId: provider.id, name: 'slow', label: 'Revision slow' },
    })
  ).json();
  try {
    await page.goto('/#/settings/models');
    const card = page
      .locator('.models-provider-card')
      .filter({ has: page.getByRole('heading', { name: sourceName, exact: true }) });
    await expect(card.getByText('模型列表正常')).toBeVisible();
    await page.goto('/#/chat');
    await chooseModel(page, { id: good.id });
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('原来的问题');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();
    await page.getByRole('button', { name: '编辑提问' }).click();
    await expect(page.getByText('正在修改最后一次提问', { exact: false })).toBeVisible();
    await expect(input).toContainText('原来的问题');
    await input.fill('修改后的问题');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.user')).toContainText('修改后的问题');
    await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();

    await chooseModel(page, { id: broken.id });
    await input.fill('请试一次');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.locator('.message.assistant').last()).toContainText('模型连接提前结束');
    await expect(page.getByRole('button', { name: '重新输出' })).toBeVisible();
    await chooseModel(page, { id: good.id });
    await page.getByRole('button', { name: '重新输出' }).click();
    await expect(page.getByRole('button', { name: '复制回复' })).toHaveCount(2);
    await expect(page.locator('.message.user')).toHaveCount(2);
    await expect(page.locator('.message.assistant')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '重新输出' })).toHaveCount(0);

    await chooseModel(page, { id: slow.id });
    await input.fill('等待慢速回复');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.locator('.message.assistant').last()).toContainText('慢速回复');
    await page.getByRole('button', { name: '停止生成' }).click();
    await expect(page.getByRole('button', { name: '重新输出' })).toBeVisible();
    await chooseModel(page, { id: good.id });
    await page.getByRole('button', { name: '重新输出' }).click();
    await expect(page.getByRole('button', { name: '复制回复' })).toHaveCount(3);
    await expect(page.locator('.message.user')).toHaveCount(3);
    await expect(page.locator('.message.assistant')).toHaveCount(3);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  } finally {
    await page.request.delete(`/api/admin/providers/${provider.id}`, { data: {} });
  }
});
