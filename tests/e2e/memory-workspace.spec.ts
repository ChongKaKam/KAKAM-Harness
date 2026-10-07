import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { defaultConfig, defaultPreferences } from '../../src/features/memory/config';
import { defaultStrategy } from '../../src/features/memory/strategies/default';
import type { MemoryItem, MemoryPreferences } from '../../src/shared/memory';

test('memory workspace filters, traces, admits and edits memories, and exposes policy settings', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const groupId = randomUUID(),
    conversationId = randomUUID(),
    messageId = randomUUID();
  const embeddingId = randomUUID(),
    llmId = randomUUID();
  const now = '2026-10-07T01:00:00.000Z';
  const makeItem = (overrides: Partial<MemoryItem>): MemoryItem => ({
    id: randomUUID(),
    scope: 'user',
    scopeId: null,
    kind: 'fact',
    content: '',
    status: 'pending',
    version: 1,
    tags: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    admittedAt: null,
    sources: [],
    ...overrides,
  });
  const pending = makeItem({
    content: '偏好简短的中文回答',
    tags: ['表达'],
    sources: [
      { conversationId, messageId, hash: 'abc123'.repeat(10), evidence: '请用简短的中文回答' },
    ],
  });
  const historic = makeItem({ content: '历史长期记忆', status: 'active' });
  const grouped = makeItem({
    scope: 'group',
    scopeId: groupId,
    status: 'active',
    content: '项目采用 PostgreSQL',
    tags: ['数据库'],
  });
  const items = [pending, historic, grouped];
  let preferences: MemoryPreferences = {
    ...defaultPreferences,
    embeddingModelId: embeddingId,
    recallModelId: llmId,
    extractModelId: llmId,
    writeModes: { ...defaultPreferences.writeModes },
  };
  let admissions = 0,
    configSaves = 0,
    sourceReads = 0;
  await page.route('**/api/conversation-groups', (route) =>
    route.fulfill({ json: [{ id: groupId, name: '项目 Alpha', icon: 'folder', colorSlot: null }] }),
  );
  await page.route('**/api/models?kind=all', (route) =>
    route.fulfill({
      json: [
        {
          id: embeddingId,
          label: 'Fixture embedding',
          providerName: 'Local mock',
          kind: 'embedding',
          enabled: true,
          validatedDimensions: 3,
        },
        { id: llmId, label: 'Fixture LLM', providerName: 'Local mock', kind: 'llm', enabled: true },
      ],
    }),
  );
  await page.route('**/api/memory/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (path.endsWith('/status'))
      return route.fulfill({ json: { configured: true, ready: true, error: null, spaces: [] } });
    if (path.endsWith('/preferences')) {
      if (request.method() === 'PATCH') preferences = { ...preferences, ...request.postDataJSON() };
      return route.fulfill({ json: preferences });
    }
    if (path.endsWith('/strategies')) return route.fulfill({ json: [defaultStrategy.info] });
    if (path.endsWith('/config')) {
      if (request.method() === 'PATCH') configSaves++;
      return route.fulfill({ json: { version: configSaves, config: defaultConfig } });
    }
    if (path.endsWith('/proposals')) return route.fulfill({ json: [] });
    if (path.endsWith('/sources')) {
      sourceReads++;
      return route.fulfill({
        json: [
          {
            ...pending.sources[0],
            status: sourceReads === 1 ? 'available' : 'changed',
            role: 'user',
            excerpt: sourceReads === 1 ? '请用简短的中文回答' : null,
            conversationTitle: '回答风格',
            inputTruncated: false,
          },
        ],
      });
    }
    if (path.endsWith('/admission')) {
      const item = items.find((entry) => path.includes(entry.id))!;
      const body = request.postDataJSON();
      expect(body.version).toBe(item.version);
      admissions++;
      item.version++;
      item.status = body.decision === 'include' ? 'active' : 'pending';
      item.admittedAt = body.decision === 'include' ? now : null;
      return route.fulfill({ json: item });
    }
    if (request.method() === 'PATCH' && path.includes('/memories/')) {
      const item = items.find((entry) => path.endsWith(entry.id))!;
      const body = request.postDataJSON();
      expect(body.version).toBe(item.version);
      Object.assign(item, body, { version: item.version + 1, status: 'pending', admittedAt: null });
      return route.fulfill({ json: item });
    }
    if (path.endsWith('/memories')) {
      if (request.method() === 'POST') {
        const item = makeItem(request.postDataJSON());
        items.push(item);
        return route.fulfill({ status: 201, json: item });
      }
      const query = url.searchParams;
      return route.fulfill({
        json: items.filter(
          (item) =>
            (!query.get('scope') || item.scope === query.get('scope')) &&
            (!query.get('scopeId') || item.scopeId === query.get('scopeId')) &&
            (!query.get('status') || item.status === query.get('status')) &&
            (!query.get('query') ||
              `${item.content} ${item.tags.join(' ')}`.includes(query.get('query')!)),
        ),
      });
    }
    return route.abort();
  });
  await page.goto('/#/memory');
  await expect(page.getByRole('heading', { name: '记忆', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '记忆库', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: '工作区' })
      .getByRole('button', { name: '记忆 插件', exact: true }),
  ).toBeVisible();
  if (info.project.name === 'mobile')
    await page.getByRole('button', { name: '收起导航', exact: true }).click();
  await expect(page.getByText('历史纳入（时间未记录）', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '记忆状态', exact: true }).selectOption('pending');
  await expect(page.locator('.memory-list .memory-item')).toHaveCount(1);
  await page.getByRole('button', { name: '来源与原文 · 1', exact: true }).click();
  const sources = page.getByRole('dialog', { name: '记忆来源与原文' });
  await expect(sources).toContainText('请用简短的中文回答');
  await expect(sources).toContainText('原文可追溯');
  await sources.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.getByRole('button', { name: '审核并纳入', exact: true }).click();
  const admission = page.getByRole('dialog', { name: '确认纳入长期记忆' });
  await expect(admission).toContainText(pending.content);
  expect(admissions).toBe(0);
  await admission.getByRole('button', { name: '确认纳入', exact: true }).click();
  await expect.poll(() => admissions).toBe(1);
  await expect(page.getByText('没有匹配的记忆', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '记忆状态', exact: true }).selectOption('active');
  const admittedCard = page.locator('.memory-item').filter({ hasText: pending.content });
  await expect(admittedCard).toContainText('纳入时间');
  await admittedCard.getByRole('button', { name: '撤回纳入', exact: true }).click();
  await page
    .getByRole('dialog', { name: '撤回长期记忆' })
    .getByRole('button', { name: '确认撤回', exact: true })
    .click();
  await expect.poll(() => admissions).toBe(2);
  await page.getByRole('combobox', { name: '记忆状态', exact: true }).selectOption('pending');
  await page.getByRole('button', { name: '来源与原文 · 1', exact: true }).click();
  await expect(sources).toContainText('原消息已修改');
  await expect(sources).toContainText('保存时的证据摘录');
  await expect(sources).toContainText('请用简短的中文回答');
  await sources.getByRole('button', { name: '关闭来源', exact: true }).click();
  await page.getByRole('button', { name: '编辑记忆', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '编辑记忆' });
  await expect(editor).toContainText('需要再次审核确认');
  await editor
    .getByRole('textbox', { name: '记忆正文', exact: true })
    .fill('偏好中文并附带必要的代码示例');
  await editor.getByRole('button', { name: '保存记忆', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByText('偏好中文并附带必要的代码示例', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加记忆', exact: true }).click();
  const adding = page.getByRole('dialog', { name: '添加记忆', exact: true });
  await expect(adding).toContainText('保存后进入待纳入状态');
  await adding.getByRole('textbox', { name: '记忆正文', exact: true }).fill('手动补充的长期偏好');
  await adding.getByRole('button', { name: '保存记忆', exact: true }).click();
  await expect(adding).not.toBeVisible();
  await expect(page.getByText('手动补充的长期偏好', { exact: true })).toBeVisible();
  expect(items.find((item) => item.content === '手动补充的长期偏好')?.status).toBe('pending');
  await page.getByRole('combobox', { name: '记忆状态', exact: true }).selectOption('');
  await page.getByRole('combobox', { name: '记忆范围', exact: true }).selectOption('group');
  await page.getByRole('combobox', { name: '分组', exact: true }).selectOption(groupId);
  await expect(page.locator('.memory-list .memory-item')).toHaveCount(1);
  await expect(page.getByText(grouped.content, { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索记忆', exact: true }).fill('不存在的内容');
  await expect(page.getByText('没有匹配的记忆', { exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索记忆', exact: true }).fill('');
  await expect(page.getByText(grouped.content, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/memory-workspace-${info.project.name}.png` });
  await page.getByRole('tab', { name: '待纳入与候选', exact: true }).click();
  await expect(page.getByRole('heading', { name: '待纳入长期记忆', exact: true })).toBeVisible();
  await expect(page.getByText('偏好中文并附带必要的代码示例', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '策略设置', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '当前策略', exact: true })).toHaveValue(
    'default',
  );
  await page.getByRole('combobox', { name: '长期记忆写入方式', exact: true }).selectOption('auto');
  await page.getByRole('button', { name: '保存记忆设置', exact: true }).click();
  await expect.poll(() => preferences.writeModes.user).toBe('auto');
  await expect(page.getByText('自动存为待纳入', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '保存策略设置', exact: true }).click();
  await expect.poll(() => configSaves).toBe(1);
  await page.goto('/#/settings/memory');
  await expect(page.getByRole('heading', { name: '记忆设置', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '策略设置', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(errors).toEqual([]);
});
