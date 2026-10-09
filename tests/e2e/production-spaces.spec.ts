import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { colorPatterns } from '../../src/shared/appearance';
import type { Conversation, ConversationGroup } from '../../src/shared/types';
import type { ProductionArtifact } from '../../src/features/llm-production/types';

test('conversation artifact cards use pattern icons, filter sources and retain shared group access', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const appearance = await (await request.get('/api/preferences')).json();
  const user = (await (await request.get('/api/auth/me')).json()).user;
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const groups: ConversationGroup[] = [
    { id: id(101), name: 'ZTE-Communication', icon: 'code', colorSlot: 1 },
    { id: id(102), name: '设计灵感', icon: 'sparkles', colorSlot: null },
  ];
  const names = [
    '为旅行做一张封面',
    '新产品视觉方案',
    '写一个网页计算器',
    '整理本周工作',
    '整理通信测试数据',
    '项目方案整理',
    '为产品生成插画',
    '比较几款模型的差异',
  ];
  const files = [
    '封面.png',
    '海报.png',
    '计算器.html',
    '周报.md',
    '测试数据.xlsx',
    '项目方案.pdf',
    '插画.png',
    '对比.md',
  ];
  const mimes = [
    'image/png',
    'image/png',
    'text/html',
    'text/markdown',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
    'image/png',
    'text/markdown',
  ];
  const conversations: Conversation[] = names.map((title, index) => ({
    id: id(index + 1),
    title,
    updatedAt: `2026-10-${String(9 - index).padStart(2, '0')}T12:00:00.000Z`,
    groupId: index < 3 ? groups[0].id : index < 5 ? groups[1].id : null,
    colorSlot: null,
    generating: false,
  }));
  const artifacts: ProductionArtifact[] = conversations.map((conversation, index) => ({
    id: id(201 + index),
    name: files[index],
    mimeType: mimes[index],
    size: 100,
    createdAt: conversation.updatedAt,
    expiresAt: null,
    conversationId: conversation.id,
    messageId: null,
    groupId: conversation.groupId,
    spaceName:
      groups.find((group) => group.id === conversation.groupId)?.name ?? conversation.title,
  }));
  artifacts.push({
    ...artifacts[0],
    id: id(209),
    name: '额外数据.json',
    mimeType: 'application/json',
  });
  await page.route('**/api/conversations', (route) => route.fulfill({ json: conversations }));
  await page.route('**/api/conversation-groups', (route) => route.fulfill({ json: groups }));
  await page.route('**/api/llm-production/artifacts*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const conversation = conversations.find((item) => item.id === params.get('conversationId'));
    const groupId = params.get('groupId') ?? conversation?.groupId;
    const selected = artifacts.filter((artifact) =>
      groupId
        ? artifact.groupId === groupId
        : conversation
          ? artifact.conversationId === conversation.id
          : true,
    );
    route.fulfill({
      json: {
        artifacts: selected,
        space: groupId
          ? {
              id: groupId,
              kind: 'group',
              name: groups.find((group) => group.id === groupId)!.name,
              artifactCount: selected.length,
              size: selected.length * 100,
            }
          : null,
      },
    });
  });
  const cards = page.locator('.llm-production-conversation-card');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    for (const [theme, colorPattern] of [
      ['dark', 'natural'],
      ['light', 'classic'],
    ] as const) {
      await request.patch('/api/preferences', { data: { ...appearance, theme, colorPattern } });
      await page.goto('/#/llm-production');
      await page.reload();
      await expect(cards).toHaveCount(8);
      await expect(page.locator('.llm-production-conversation-cover img')).toHaveCount(0);
      await expect(page.locator('.llm-production-conversation-cover svg')).toHaveCount(8);
      await expect(cards.first()).toContainText('2 个产物');
      const groupButton = page.getByRole('button', {
        name: '筛选分组 ZTE-Communication',
        exact: true,
      });
      const expected = colorPatterns.resolve(colorPattern, theme, { key: groups[0].id, slot: 1 });
      expect(
        await groupButton.evaluate((element) => element.style.getPropertyValue('--item-color')),
      ).toBe(expected.tokens['--item-color']);
      expect(await cards.first().evaluate((element) => getComputedStyle(element).boxShadow)).toBe(
        'none',
      );
      await page.screenshot({
        path: info.outputPath(`production-spaces-${theme}.png`),
        fullPage: true,
      });
      await page.getByRole('searchbox', { name: '搜索对话或产物', exact: true }).fill('额外数据');
      await expect(cards).toHaveCount(1);
      await page.getByRole('searchbox', { name: '搜索对话或产物', exact: true }).fill('');
      await page.getByRole('radio', { name: '网页', exact: true }).check();
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText('写一个网页计算器');
      await page.getByRole('radio', { name: '全部', exact: true }).check();
      await groupButton.click();
      await expect(cards).toHaveCount(3);
      const opener = page.getByRole('button', { name: `管理对话产物 ${names[0]}`, exact: true });
      await opener.click();
      await expect(page.getByRole('heading', { name: names[0], exact: true })).toBeFocused();
      await expect(page.locator('.llm-production-item')).toHaveCount(2);
      await expect(page.locator('.llm-production-item')).toContainText([
        '封面.png',
        '额外数据.json',
      ]);
      await expect(page.getByRole('button', { name: '预览 海报.png', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '查看分组全部产物', exact: true }).click();
      await expect(page.locator('.llm-production-item')).toHaveCount(4);
      await page.getByRole('button', { name: '返回产物空间', exact: true }).click();
      await expect(opener).toBeFocused();
      await expect(groupButton).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: '筛选分组 未分组', exact: true }).click();
      await expect(cards).toHaveCount(3);
      await page.getByRole('button', { name: '列表视图', exact: true }).click();
      await expect(page.locator('.llm-production-conversation-grid')).toHaveClass(/is-list/);
      await page.getByRole('button', { name: '卡片视图', exact: true }).click();
      await page.getByRole('button', { name: '筛选分组 全部空间', exact: true }).click();
      await page.getByLabel('对话空间排序', { exact: true }).selectOption('name');
      const rendered = await cards.locator('strong').allTextContents();
      expect(rendered).toEqual([...names].sort((a, b) => a.localeCompare(b, 'zh-CN')));
      await page.evaluate((id) => localStorage.setItem(`drift:font-size:${id}`, 'large'), user.id);
      await page.reload();
      await expect(cards).toHaveCount(8);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      for (const card of await cards.all()) {
        expect(
          await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
      }
      await page.screenshot({
        path: info.outputPath(`production-spaces-large-${theme}.png`),
        fullPage: true,
      });
      await page.evaluate((id) => localStorage.removeItem(`drift:font-size:${id}`), user.id);
    }
    // Deleted sources remain manageable, but archived files from other groups stay separate.
    artifacts.push(
      {
        ...artifacts[0],
        id: id(210),
        name: '分组保留.md',
        mimeType: 'text/markdown',
        conversationId: null,
      },
      {
        ...artifacts[5],
        id: id(211),
        name: '临时保留.md',
        mimeType: 'text/markdown',
        conversationId: null,
      },
    );
    await page.reload();
    await expect(cards).toHaveCount(10);
    await page.getByRole('button', { name: '筛选分组 未分组', exact: true }).click();
    await page.getByRole('button', { name: '管理对话产物 已删除对话的产物', exact: true }).click();
    await expect(page.locator('.llm-production-item')).toHaveCount(1);
    await expect(page.locator('.llm-production-item')).toContainText('临时保留.md');
    await page.getByRole('button', { name: '返回产物空间', exact: true }).click();
    await page.getByRole('button', { name: '筛选分组 ZTE-Communication', exact: true }).click();
    await page.getByRole('button', { name: '管理对话产物 已删除对话的产物', exact: true }).click();
    await expect(page.locator('.llm-production-item')).toHaveCount(1);
    await expect(page.locator('.llm-production-item')).toContainText('分组保留.md');
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await request.patch('/api/preferences', { data: appearance });
    await page.evaluate((id) => localStorage.removeItem(`drift:font-size:${id}`), user.id);
  }
});
