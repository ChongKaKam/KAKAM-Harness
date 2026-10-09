import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';
import { imageData } from '../mock-provider';

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
  const alternate = await (
    await page.request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'test-vision',
        label: 'Revision alternate',
        vision: true,
      },
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
    const originalHash = new URL(page.url()).hash;
    await input.fill('原会话未发送的草稿');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'draft.png',
      mimeType: 'image/png',
      buffer: Buffer.from(imageData.split(',')[1], 'base64'),
    });
    await expect(page.locator('.attachment-list img')).toHaveCount(1);
    await page.getByRole('button', { name: '编辑提问' }).click();
    await expect(page.getByText('正在修改最后一次提问', { exact: false })).toBeVisible();
    await expect(input).toContainText('原来的问题');
    const other = await (await page.request.post('/api/conversations', { data: {} })).json();
    await page.evaluate((id) => {
      location.hash = `/chat/${id}`;
    }, other.id);
    await expect(input).toHaveText('');
    await expect(page.locator('.attachment-list img')).toHaveCount(0);
    await expect(page.getByText('正在修改最后一次提问', { exact: false })).toHaveCount(0);
    await input.fill('另一会话的独立草稿');
    await page.evaluate((hash) => {
      location.hash = hash;
    }, originalHash);
    await expect(input).toContainText('原来的问题');
    await expect(page.getByText('正在修改最后一次提问', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '取消编辑提问' }).click();
    await expect(input).toContainText('原会话未发送的草稿');
    await expect(page.locator('.attachment-list img')).toHaveCount(1);
    await page.evaluate((id) => {
      location.hash = `/chat/${id}`;
    }, other.id);
    await expect(input).toContainText('另一会话的独立草稿');
    await expect(page.locator('.attachment-list img')).toHaveCount(0);
    await page.evaluate((hash) => {
      location.hash = hash;
    }, originalHash);
    await page.getByRole('button', { name: '编辑提问' }).click();
    await input.fill('修改后的问题');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.message.user')).toContainText('修改后的问题');
    await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();

    const before = (
      await (await page.request.get(`/api/conversations/${originalHash.split('/')[2]}`)).json()
    ).messages;
    await input.fill('再次生成时保留的草稿');
    const regenerateTrigger = page.getByRole('button', { name: '再次生成', exact: true });
    await regenerateTrigger.click();
    await page.keyboard.press('Escape');
    await expect(regenerateTrigger).toBeFocused();
    await regenerateTrigger.click();
    const regenerate = page.getByRole('dialog', { name: '再次生成回复', exact: true });
    await regenerate.getByRole('button', { name: /^模型与思考程度：/ }).click();
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    await page
      .getByRole('radiogroup', { name: '可用模型' })
      .locator(`[data-model-id="${alternate.id}"]`)
      .click();
    await page.getByRole('button', { name: '思考程度 Low', exact: true }).click();
    await page.getByRole('button', { name: '关闭模型设置' }).click();
    await page.screenshot({ path: `/tmp/drift-regenerate-${info.project.name}.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect
      .poll(() => regenerate.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
    await page.screenshot({ path: `/tmp/drift-regenerate-dark-${info.project.name}.png` });
    await page.emulateMedia({ colorScheme: 'light' });
    const submission = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/messages'),
    );
    await regenerate.getByRole('button', { name: '开始生成' }).click();
    const submitted = (await submission).postDataJSON();
    expect(submitted.modelId).toBe(alternate.id);
    expect(submitted.reasoningEffort).toBe('low');
    expect(submitted.replaceLastMessageId).toBe(before[0].id);
    await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();
    await expect(page.locator('.message.assistant')).toContainText('Revision alternate');
    await expect(input).toContainText('再次生成时保留的草稿');
    const after = (
      await (await page.request.get(`/api/conversations/${originalHash.split('/')[2]}`)).json()
    ).messages;
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).not.toBe(before[1].id);
    const usage = await (await page.request.get('/api/usage')).json();
    expect(usage.rows.some((row: { id: string }) => row.id === before[1].id)).toBe(true);

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
    await page.evaluate((id) => {
      location.hash = `/chat/${id}`;
    }, other.id);
    await chooseModel(page, { id: good.id });
    await expect(input).toContainText('另一会话的独立草稿');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();
    await page.evaluate((hash) => {
      location.hash = hash;
    }, originalHash);
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
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
