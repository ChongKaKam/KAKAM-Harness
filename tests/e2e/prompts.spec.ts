import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { fontSizes } from '../../src/shared/typography';

test('prompt editing, descriptions, tags and search work with readable responsive cards', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const request = page.context().request;
  const originalPrefs = await (await request.get('/api/preferences')).json();
  const user = (await (await request.get('/api/auth/me')).json()).user;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `Prompt model ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'test',
      },
    })
  ).json();
  const model = await (
    await request.post('/api/admin/models', {
      data: { providerId: provider.id, name: 'test-text', label: '简介小模型' },
    })
  ).json();
  await page.goto('/#/settings/prompts');
  await page.getByRole('combobox', { name: '简介模型', exact: true }).selectOption(model.id);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('简介模型已保存');
  await page.goto('/#/prompts');
  await page.getByRole('button', { name: '新建Skill', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const title = `我的写作伙伴 ${info.project.name}`;
  const body = '请整理写作思路，保留正文标记 unique-draft-phrase。';
  await dialog.getByLabel('名称', { exact: true }).fill(title);
  await dialog.getByLabel('主指令（SKILL.md）', { exact: true }).fill(body);
  await dialog.getByLabel(/^标签/).fill('写作，工作');
  await dialog.getByRole('button', { name: '添加标签', exact: true }).click();
  await dialog.getByRole('button', { name: '生成简介', exact: true }).click();
  await expect(dialog.getByLabel('卡片简介', { exact: true })).toHaveValue(/梳理写作思路/);
  await dialog.getByRole('button', { name: '保存Skill', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const card = page.getByRole('article', { name: title, exact: true });
  await expect(card.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const saved = (await (await request.get('/api/prompts')).json()).find(
    (p: { title: string }) => p.title === title,
  );
  await request.patch(`/api/prompts/${saved.id}/color`, { data: { colorSlot: 6 } });
  const other = await (
    await request.post('/api/prompts', {
      data: { title: '阅读笔记', content: '读书记录', tags: ['阅读'] },
    })
  ).json();
  await page.reload();
  await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
  await dialog.getByLabel('卡片简介', { exact: true }).fill('把零散想法整理为条理清晰的文章。');
  await dialog.getByRole('button', { name: '移除标签 工作', exact: true }).click();
  await dialog.getByLabel(/^标签/).fill('灵感');
  await dialog.getByLabel(/^标签/).press('Enter');
  await dialog.getByLabel('主指令（SKILL.md）', { exact: true }).fill(body + ' 编辑后的完整正文。');
  await dialog.getByRole('button', { name: '保存Skill', exact: true }).click();
  await expect(card).toContainText('把零散想法整理为条理清晰的文章。');
  expect(
    (await (await request.get('/api/prompts')).json()).find(
      (p: { id: string }) => p.id === saved.id,
    ).colorSlot,
  ).toBe(6);
  await page.getByRole('searchbox', { name: '搜索Skill' }).fill('unique-draft-phrase');
  await expect(page.locator('.prompt-card')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索Skill' }).fill('条理清晰');
  await expect(card).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索Skill' }).fill('完全不存在的技能关键词');
  await expect(page.getByText('没有找到匹配的Skill')).toBeVisible();
  await page.getByRole('button', { name: '清空搜索', exact: true }).click();
  const filters = page.getByRole('group', { name: '按标签筛选' });
  await filters.getByRole('button', { name: '写作', exact: true }).click();
  await filters.getByRole('button', { name: '灵感', exact: true }).click();
  await expect(page.locator('.prompt-card')).toHaveCount(1);
  await filters.getByRole('button', { name: '阅读', exact: true }).click();
  await expect(page.getByText('没有找到匹配的Skill')).toBeVisible();
  await page.getByRole('button', { name: '清除搜索与筛选', exact: true }).click();
  await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(card.getByRole('button', { name: `编辑 ${title}`, exact: true })).toBeFocused();
  for (const theme of ['light', 'dark'] as const) {
    await request.patch('/api/preferences', {
      data: { ...originalPrefs, theme, colorPattern: theme === 'light' ? 'natural' : 'classic' },
    });
    for (const size of fontSizes) {
      await page.evaluate(
        ({ userId, size }) => localStorage.setItem(`drift:font-size:${userId}`, size),
        { userId: user.id, size: size.id },
      );
      await page.reload();
      await expect(card).toBeVisible();
      const sizes = await card.evaluate((element) => [
        parseFloat(getComputedStyle(element.querySelector('h2')!).fontSize),
        parseFloat(getComputedStyle(element.querySelector('.prompts-card-description')!).fontSize),
      ]);
      expect(sizes[0]).toBeGreaterThan(sizes[1]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (size.id === 'large') {
        await page.screenshot({
          path: `test-results/prompts-${theme}-${info.project.name}.png`,
          fullPage: true,
        });
        await card.getByRole('button', { name: `编辑 ${title}`, exact: true }).click();
        await expect(dialog).toBeVisible();
        const bounds = (await dialog.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        await page.screenshot({
          path: `test-results/prompt-editor-${theme}-${info.project.name}.png`,
        });
        await page.keyboard.press('Escape');
      }
    }
  }
  await card.getByRole('button', { name: '载入新对话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeEmpty();
  await expect(page.getByLabel('已选 Skill')).toContainText(title);
  await page.goto('/#/prompts');
  await card.getByRole('button', { name: `更多操作 ${title}` }).click();
  await expect(card.getByRole('button', { name: `设置颜色 ${title}` })).toBeVisible();
  await card.getByRole('button', { name: `删除 ${title}`, exact: true }).click();
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
  await request.delete(`/api/prompts/${other.id}`);
  await request.delete(`/api/admin/providers/${provider.id}`);
  await request.patch('/api/preferences', { data: originalPrefs });
});
