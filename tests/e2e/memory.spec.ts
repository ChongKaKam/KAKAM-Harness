import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';

test('memory database setup state leaves chat usable', async ({ page }, info) => {
  test.skip(
    !!process.env.MEMORY_TEST_DATABASE_URL,
    'This case requires the unconfigured database fixture.',
  );
  await useFixtureSession(page);
  const request = page.context().request;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `Memory unavailable ${info.project.name}`,
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
        label: `Memory fallback ${info.project.name}`,
      },
    })
  ).json();
  try {
    await page.goto('/#/settings/memory');
    await expect(page.getByRole('status')).toContainText('记忆数据库尚未配置');
    await page.goto('/#/chat');
    await chooseModel(page, { id: model.id });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('记忆未配置时也可以聊天');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.message.assistant')).toContainText('你好');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
  } finally {
    await request.delete(`/api/admin/providers/${provider.id}`);
  }
});

test('memory settings, paired strategy panel and manual CRUD work on desktop and mobile', async ({
  page,
}, info) => {
  test.skip(
    !process.env.MEMORY_TEST_DATABASE_URL,
    'This case requires the isolated PostgreSQL/pgvector fixture.',
  );
  await useFixtureSession(page);
  const request = page.context().request;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const preferencesResponse = await request.get('/api/memory/v1/preferences');
  expect(preferencesResponse.ok()).toBe(true);
  const originalPreferences = await preferencesResponse.json();
  const configResponse = await request.get('/api/memory/v1/strategies/default/config');
  expect(configResponse.ok()).toBe(true);
  const originalConfig = await configResponse.json();
  const originalUi = await (await request.get('/api/preferences')).json();
  const { user } = await (await request.get('/api/auth/me')).json();
  await page.goto('/#/settings/preferences');
  const originalFont = await page.evaluate(
    (userId) => localStorage.getItem(`drift:font-size:${userId}`),
    user.id,
  );
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `Memory UI ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
      },
    })
  ).json();
  const llm = await (
    await request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'test-text',
        label: `Memory LLM ${info.project.name}`,
        kind: 'llm',
      },
    })
  ).json();
  const embedding = await (
    await request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'memory-embedding',
        label: `Memory embedding ${info.project.name}`,
        kind: 'embedding',
        embeddingDimensions: 3,
      },
    })
  ).json();
  const tested = await request.post(`/api/admin/models/${embedding.id}/test`, { data: {} });
  expect(tested.ok()).toBe(true);
  expect((await tested.json()).ok).toBe(true);
  let memoryId: string | undefined;
  try {
    await page.goto('/#/settings/memory');
    await expect(page.locator('.memory-service-state')).toContainText(
      'PostgreSQL / pgvector 已连接',
    );
    const embeddingSelect = page.getByRole('combobox', { name: 'Embedding 模型', exact: true });
    await expect(
      embeddingSelect
        .locator('option')
        .filter({ hasText: `Memory embedding ${info.project.name}` }),
    ).toContainText('3 维');
    await embeddingSelect.selectOption(embedding.id);
    await page.getByRole('combobox', { name: '记忆检索 LLM', exact: true }).selectOption(llm.id);
    await page.getByRole('combobox', { name: '记忆抽取 LLM', exact: true }).selectOption(llm.id);
    await page.getByRole('button', { name: '保存记忆设置', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await request.get('/api/memory/v1/preferences')).json()).embeddingModelId,
      )
      .toBe(embedding.id);
    await expect(page.getByRole('heading', { name: '策略内部设置', exact: true })).toBeVisible();
    await page.getByRole('spinbutton', { name: '检索候选数量', exact: true }).fill('24');
    const recallPrompt = page.getByRole('textbox', { name: '检索 Prompt', exact: true });
    await page.getByText('Prompt 微调', { exact: true }).click();
    await recallPrompt.fill('Edited prompt with {{context}} and {{candidates}} for a test.');
    await page.getByRole('button', { name: '恢复默认检索 Prompt', exact: true }).click();
    await expect(recallPrompt).toHaveValue(originalConfig.config.recallPrompt);
    await page.getByRole('button', { name: '保存策略设置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '策略内部设置已保存' })).toBeVisible();
    expect(
      (await (await request.get('/api/memory/v1/strategies/default/config')).json()).config
        .candidateLimit,
    ).toBe(24);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/memory-settings-${info.project.name}.png` });
    await expect(
      page
        .getByRole('combobox', { name: '记忆检索 LLM', exact: true })
        .locator('option')
        .filter({ hasText: 'Memory embedding' }),
    ).toHaveCount(0);
    await page.getByRole('tab', { name: '记忆库', exact: true }).click();
    await page.getByRole('button', { name: '添加记忆', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '添加记忆', exact: true });
    const initialText = `UI memory ${info.project.name} 喜欢清楚的中文回答 📚`;
    await editor.getByRole('textbox', { name: '记忆正文', exact: true }).fill(initialText);
    await editor
      .getByRole('textbox', { name: '标签（逗号分隔）', exact: true })
      .fill('界面测试, 中文');
    const savedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/memory/v1/memories') &&
        response.request().method() === 'POST',
    );
    await editor.getByRole('button', { name: '保存记忆', exact: true }).click();
    const saved = await (await savedResponse).json();
    memoryId = saved.id;
    await expect(editor).not.toBeVisible();
    const row = page.locator('.memory-item').filter({ hasText: initialText });
    await expect(row).toContainText('长期记忆');
    await expect(row).toContainText('中文');
    await row.getByRole('button', { name: '编辑记忆', exact: true }).click();
    const editedText = `${initialText}，编辑后仍保留。`;
    const editDialog = page.getByRole('dialog', { name: '编辑记忆', exact: true });
    await editDialog.getByRole('textbox', { name: '记忆正文', exact: true }).fill(editedText);
    await editDialog.getByRole('button', { name: '保存记忆', exact: true }).click();
    await expect(editDialog).not.toBeVisible();
    const editedRow = page.locator('.memory-item').filter({ hasText: editedText });
    await expect(editedRow).toContainText('v2');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/memory-library-${info.project.name}.png` });
    await request.patch('/api/preferences', { data: { ...originalUi, theme: 'dark' } });
    await page.evaluate(
      (userId) => localStorage.setItem(`drift:font-size:${userId}`, 'large'),
      user.id,
    );
    await page.reload();
    await page.getByRole('tab', { name: '记忆库', exact: true }).click();
    await expect(editedRow).toBeVisible();
    await editedRow.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/memory-library-dark-large-${info.project.name}.png`,
    });
    await editedRow.getByRole('button', { name: '删除记忆', exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '删除记忆', exact: true });
    await deletion.getByRole('button', { name: '删除记忆', exact: true }).click();
    await expect(deletion).not.toBeVisible();
    await expect(page.locator('.memory-item').filter({ hasText: editedText })).toHaveCount(0);
    memoryId = undefined;
    await page.getByRole('tab', { name: '索引与任务', exact: true }).click();
    await expect(page.getByRole('heading', { name: '向量空间', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重建当前模型索引', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (memoryId) await request.delete(`/api/memory/v1/memories/${memoryId}`);
    const currentConfig = await (
      await request.get('/api/memory/v1/strategies/default/config')
    ).json();
    await request.patch('/api/memory/v1/strategies/default/config', {
      data: { version: currentConfig.version, config: originalConfig.config },
    });
    await request.patch('/api/memory/v1/preferences', { data: originalPreferences });
    await request.patch('/api/preferences', { data: originalUi });
    await page.evaluate(
      ({ userId, value }) => {
        if (value === null) localStorage.removeItem(`drift:font-size:${userId}`);
        else localStorage.setItem(`drift:font-size:${userId}`, value);
      },
      { userId: user.id, value: originalFont },
    );
    await request.delete(`/api/admin/providers/${provider.id}`);
  }
});
