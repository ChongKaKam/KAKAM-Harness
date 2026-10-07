import { createHash, randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import type { MemoryItem, MemoryRememberPreview } from '../../src/shared/memory';

test('Remember it previews traceable text and confirms pending global or current-group memory', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const originalUi = await (await request.get('/api/preferences')).json();
  const { user } = await (await request.get('/api/auth/me')).json();
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `Remember UI ${info.project.name}`,
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
        label: `Remember LLM ${info.project.name}`,
      },
    })
  ).json();
  const group = await (
    await request.post('/api/conversation-groups', {
      data: { name: `Remember group ${info.project.name}` },
    })
  ).json();
  const conversation = await (
    await request.post('/api/conversations', { data: { groupId: group.id } })
  ).json();
  const messageId = randomUUID();
  expect(
    (
      await request.post(`/api/conversations/${conversation.id}/messages`, {
        data: {
          requestId: messageId,
          modelId: model.id,
          content: '请说明这个项目的约束。',
        },
      })
    ).status(),
  ).toBe(202);
  await request.get(`/api/conversations/${conversation.id}/events`);
  const messages = (await (await request.get(`/api/conversations/${conversation.id}`)).json())
    .messages;
  const previews = new Map<string, MemoryRememberPreview>();
  const saved: MemoryItem[] = [];
  let failed = false;
  let confirms = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/memory/v1/remember**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/remember')) {
      if (failed)
        return route.fulfill({
          status: 403,
          json: { error: '记忆抽取模型未授权，请在记忆设置中选择模型' },
        });
      const body = route.request().postDataJSON();
      expect(body).toEqual({ conversationId: conversation.id, messageId });
      const value: MemoryRememberPreview = {
        id: randomUUID(),
        conversationId: conversation.id,
        messageId,
        content: '助手说明了 Markdown 展示与模型输出，内容需按原文核对。',
        sources: messages.map((message: { id: string; content: string }) => ({
          conversationId: conversation.id,
          messageId: message.id,
          hash: createHash('sha256').update(message.content).digest('hex'),
          evidence: message.content.slice(0, 24),
        })),
        groupId: group.id,
        inputTruncated: false,
        createdAt: new Date().toISOString(),
        modelName: 'Local mock summary',
        state: 'pending',
        memoryId: null,
      };
      previews.set(value.id, value);
      return route.fulfill({ json: value });
    }
    const id = path.split('/').at(-2)!;
    const preview = previews.get(id)!;
    expect(preview).toBeDefined();
    const input = route.request().postDataJSON();
    confirms++;
    const value: MemoryItem = {
      id: randomUUID(),
      scope: input.scope,
      scopeId: input.scope === 'group' ? group.id : null,
      kind: 'episode',
      content: input.content,
      status: input.scope === 'user' ? 'pending' : 'active',
      admittedAt: null,
      version: 1,
      tags: [],
      pinned: false,
      createdAt: preview.createdAt,
      updatedAt: preview.createdAt,
      expiresAt: null,
      sources: preview.sources,
      indexStatus: 'pending',
    };
    saved.push(value);
    return route.fulfill({ json: value });
  });
  let originalFont: string | null = null;
  try {
    await page.goto(`/#/chat/${conversation.id}`);
    const remember = page
      .locator('.message.assistant')
      .getByRole('button', { name: 'Remember it · 记住这条回复', exact: true });
    await expect(remember).toBeVisible();
    originalFont = await page.evaluate(
      (userId) => localStorage.getItem(`drift:font-size:${userId}`),
      user.id,
    );
    await remember.click();
    const dialog = page.getByRole('dialog', { name: 'Remember it · 记住这条回复', exact: true });
    await expect(dialog.getByRole('textbox', { name: '记忆摘要', exact: true })).toHaveValue(
      /助手说明/,
    );
    await expect(dialog.getByLabel('摘要原文依据')).toContainText('当前回复');
    expect(confirms).toBe(0);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(confirms).toBe(0);
    await expect(remember).toBeFocused();
    await remember.click();
    const summary = dialog.getByRole('textbox', { name: '记忆摘要', exact: true });
    await expect(summary).toHaveValue(/助手说明/);
    await summary.fill('用户核对后保留的回复摘要。');
    await dialog.getByRole('combobox', { name: '保存到', exact: true }).selectOption('user');
    await page.screenshot({ path: `test-results/remember-preview-${info.project.name}.png` });
    await dialog.getByRole('button', { name: '确认保存为待纳入', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('待纳入长期记忆');
    expect(saved[0].status).toBe('pending');
    expect(saved[0].content).toBe('用户核对后保留的回复摘要。');
    await expect(dialog.getByRole('button', { name: '前往待纳入记忆', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '继续对话', exact: true }).click();
    await request.patch('/api/preferences', { data: { ...originalUi, theme: 'dark' } });
    await page.evaluate(
      (userId) => localStorage.setItem(`drift:font-size:${userId}`, 'large'),
      user.id,
    );
    await page.reload();
    await remember.click();
    await expect(summary).toHaveValue(/助手说明/);
    await expect(dialog.getByRole('combobox', { name: '保存到', exact: true })).toHaveValue(
      'group',
    );
    await page.screenshot({ path: `test-results/remember-dark-large-${info.project.name}.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await dialog.getByRole('button', { name: '确认保存到分组', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('已保存到当前分组记忆');
    expect(saved[1].status).toBe('active');
    expect(saved[1].scopeId).toBe(group.id);
    await dialog.getByRole('button', { name: '继续对话', exact: true }).click();
    failed = true;
    await remember.click();
    await expect(dialog.getByRole('alert')).toContainText('模型未授权');
    await expect(dialog.getByRole('button', { name: '打开记忆设置', exact: true })).toBeVisible();
    expect(confirms).toBe(2);
    failed = false;
    await dialog.getByRole('button', { name: '重新提炼', exact: true }).click();
    await expect(summary).toHaveValue(/助手说明/);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(confirms).toBe(2);
    const nextId = randomUUID();
    expect(
      (
        await request.post(`/api/conversations/${conversation.id}/messages`, {
          data: {
            requestId: nextId,
            modelId: model.id,
            content: '继续讨论另一个问题。',
          },
        })
      ).status(),
    ).toBe(202);
    await request.get(`/api/conversations/${conversation.id}/events`);
    await page.goto(`/#/chat/${conversation.id}/${messageId}`);
    const sourceMessage = page.locator(`.message.assistant[data-message-id="${messageId}"]`);
    await expect(sourceMessage).toContainText('来源消息');
    await expect(sourceMessage.locator('.message-author')).toBeInViewport();
    expect(pageErrors).toEqual([]);
  } finally {
    await request.patch('/api/preferences', { data: originalUi });
    await page.evaluate(
      ({ userId, font }) => {
        if (font === null) localStorage.removeItem(`drift:font-size:${userId}`);
        else localStorage.setItem(`drift:font-size:${userId}`, font);
      },
      { userId: user.id, font: originalFont },
    );
    await request.delete(`/api/conversations/${conversation.id}`);
    await request.delete(`/api/conversation-groups/${group.id}`);
    await request.delete(`/api/admin/providers/${provider.id}`);
  }
});
