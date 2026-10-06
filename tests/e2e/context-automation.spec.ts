import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import type { ContextSnapshot } from '../../src/features/context-manager/types';

test('context automation settings and generated trajectory nodes work in the drawer', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const original = await (await request.get('/api/context-manager/preferences')).json();
  const ui = await (await request.get('/api/preferences')).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `Context automation ${info.project.name}`,
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
        label: `Automation LLM ${info.project.name}`,
      },
    })
  ).json();
  const conversation = await (await request.post('/api/conversations', { data: {} })).json();
  try {
    await page.goto('/#/settings/context-manager');
    await page
      .getByRole('combobox', { name: '上下文压缩模型', exact: true })
      .selectOption(model.id);
    await page.getByRole('spinbutton', { name: '压缩触发阈值（字符）', exact: true }).fill('2000');
    await page.getByRole('spinbutton', { name: '保留最近原文（轮）', exact: true }).fill('1');
    await page.getByRole('spinbutton', { name: '压缩摘要预算（字符）', exact: true }).fill('500');
    await page.getByRole('checkbox', { name: '启用自动上下文压缩', exact: true }).check();
    await page.getByRole('combobox', { name: '轨迹摘要模型', exact: true }).selectOption(model.id);
    await page.getByRole('checkbox', { name: '回答完成后自动生成节点摘要', exact: true }).check();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('上下文设置已保存');
    const prefs = await (await request.get('/api/context-manager/preferences')).json();
    expect(prefs.compressionEnabled).toBe(true);
    expect(prefs.trajectoryEnabled).toBe(true);
    expect(prefs.compressionThreshold).toBe(2000);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/context-automation-settings-${info.project.name}.png`,
    });
    let last = '';
    for (const content of ['目标和约束'.repeat(500), '请核对模型配置', '继续说明压缩结果']) {
      last = randomUUID();
      const response = await request.post(`/api/conversations/${conversation.id}/messages`, {
        data: { requestId: last, modelId: model.id, content },
      });
      expect(response.status()).toBe(202);
      await request.get(`/api/conversations/${conversation.id}/events`);
    }
    const turnPath = `/api/context-manager/conversations/${conversation.id}/turns/${last}`;
    await expect
      .poll(async () => (await (await request.get(turnPath)).json()).trajectory?.status)
      .toBe('ready');
    const snapshot: ContextSnapshot = await (await request.get(turnPath)).json();
    expect(snapshot.compression?.status).toBe('compressed');
    await page.goto(`/#/chat/${conversation.id}`);
    const finalMessage = page.locator('.message.assistant').last();
    await finalMessage.getByRole('button', { name: '查看本轮上下文', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '对话上下文', exact: true });
    await expect(drawer.getByRole('region', { name: '轨迹节点摘要', exact: true })).toContainText(
      '用户意图',
    );
    await expect(drawer.locator('.context-manager-compression')).toContainText('本轮已压缩');
    await expect(drawer.locator('.context-manager-commit').last()).toContainText(
      '完善记忆与上下文管理',
    );
    await drawer.getByRole('button', { name: '重新生成节点摘要', exact: true }).click();
    await expect(
      drawer.getByRole('button', { name: '重新生成节点摘要', exact: true }),
    ).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/context-automation-drawer-${info.project.name}.png`,
    });
    await page.keyboard.press('Escape');
    await request.patch('/api/preferences', { data: { ...ui, theme: 'dark' } });
    await page.reload();
    await page
      .locator('.message.assistant')
      .last()
      .getByRole('button', { name: '查看本轮上下文', exact: true })
      .click();
    await expect(drawer.locator('.context-manager-trajectory')).toContainText('回答摘要');
    await page.screenshot({
      path: `test-results/context-automation-drawer-dark-${info.project.name}.png`,
    });
    expect(errors).toEqual([]);
  } finally {
    await request.patch('/api/context-manager/preferences', { data: original });
    await request.patch('/api/preferences', { data: ui });
    await request.delete(`/api/conversations/${conversation.id}`);
    await request.delete(`/api/admin/providers/${provider.id}`);
  }
});
