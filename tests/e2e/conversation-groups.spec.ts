import { test, expect, type Page } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { fontSizes } from '../../src/shared/typography';

async function openNavigation(page: Page) {
  const menu = page.getByRole('button', { name: '打开导航', exact: true });
  if (await menu.isVisible()) await menu.click();
}

test('groups organize conversations, preserve gray rows, and work across themes, sizes and touch', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const prefs = await (await request.get('/api/preferences')).json();
  await request.patch('/api/preferences', {
    data: { ...prefs, theme: 'light', colorPattern: 'natural' },
  });
  const chat = await (await request.post('/api/conversations', { data: {} })).json();
  const title = `待整理的笔记 ${info.project.name}`;
  const groupName = `阅读与灵感 ${info.project.name}`;
  await request.patch(`/api/conversations/${chat.id}`, { data: { title, colorSlot: 6 } });
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: '新建分组', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('分组名称', { exact: true }).fill(groupName);
  await modal.getByLabel('自定义 emoji', { exact: true }).fill('👩🏽‍💻');
  await modal.getByRole('radio', { name: '湖水蓝', exact: true }).check();
  await modal.getByRole('button', { name: '创建分组', exact: true }).click();
  await expect(modal).toHaveCount(0);
  const group = page.getByRole('region', { name: `分组 ${groupName}`, exact: true });
  await expect(group).toContainText('👩🏽‍💻');
  const groupData = (await (await request.get('/api/conversation-groups')).json()).find(
    (g: { name: string }) => g.name === groupName,
  );
  expect(groupData.colorSlot).toBe(6);
  const row = page.locator('.conversation-link').filter({ hasText: title });
  await row.hover();
  await row.getByRole('button', { name: `管理对话 ${title}`, exact: true }).click();
  await modal.getByLabel('所属分组').selectOption(groupData.id);
  await modal.getByRole('button', { name: '保存对话', exact: true }).click();
  await expect(group.locator('.conversation-open')).toHaveText(title);
  const toggle = group.getByRole('button', { name: `分组 ${groupName}`, exact: true });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(group.locator('.conversation-open')).toBeHidden();
  await page.getByLabel('搜索对话', { exact: true }).fill(groupName);
  await expect(group.locator('.conversation-open')).toBeVisible();
  await page.getByLabel('搜索对话', { exact: true }).fill(title);
  await expect(group).toBeVisible();
  await page.getByLabel('搜索对话', { exact: true }).fill('不存在的分组或对话');
  await expect(page.getByText('没有找到相关对话或分组')).toBeVisible();
  await page.getByLabel('搜索对话', { exact: true }).fill('');

  // Saved choices survive reload and palette changes; the original conversation color stays unused.
  for (const theme of ['light', 'dark'] as const) {
    for (const [index, size] of fontSizes.entries()) {
      const pattern = index % 2 ? 'classic' : 'natural';
      await request.patch('/api/preferences', { data: { ...prefs, theme, colorPattern: pattern } });
      const user = (await (await request.get('/api/auth/me')).json()).user;
      await page.evaluate(
        ({ userId, fontSize }) => localStorage.setItem(`drift:font-size:${userId}`, fontSize),
        { userId: user.id, fontSize: size.id },
      );
      await page.reload();
      await openNavigation(page);
      await expect(group).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(group).toContainText('👩🏽‍💻');
      await expect
        .poll(() =>
          group
            .locator('.chat-group-heading')
            .evaluate((element) => (element as HTMLElement).style.getPropertyValue('--item-color')),
        )
        .toBe(pattern === 'natural' ? '#427b98' : '#98b9ca');
      const gray = await row.evaluate((element) => {
        const values = [
          getComputedStyle(element).color,
          getComputedStyle(element).backgroundColor,
          getComputedStyle(element.querySelector('svg')!).color,
        ];
        return values.every((value) => {
          const [r, g, b] = value.match(/[\d.]+/g)!.map(Number);
          return r === g && g === b;
        });
      });
      expect(gray).toBe(true);
      await expect
        .poll(() =>
          page
            .locator('.sidebar')
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        )
        .toBe(true);
      await group.getByRole('button', { name: `编辑分组 ${groupName}`, exact: true }).click();
      await expect(
        modal.getByRole('radio', { name: pattern === 'natural' ? '湖水蓝' : '蓝灰', exact: true }),
      ).toBeChecked();
      const bounds = (await modal.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      if (size.id === 'large')
        await page.screenshot({
          path: `test-results/groups-editor-${theme}-${info.project.name}.png`,
        });
      await page.keyboard.press('Escape');
      await expect(
        group.getByRole('button', { name: `编辑分组 ${groupName}`, exact: true }),
      ).toBeFocused();
    }
    await page.screenshot({
      path: `test-results/groups-sidebar-${theme}-${info.project.name}.png`,
    });
  }
  await group.getByRole('button', { name: `在 ${groupName} 中新建对话`, exact: true }).click();
  await expect(page).toHaveURL(/#\/chat\/.+/);
  const newId = page.url().split('/').at(-1)!;
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/conversations')).json()).find(
          (c: { id: string }) => c.id === newId,
        )?.groupId,
    )
    .toBe(groupData.id);
  if (info.project.name === 'mobile') await openNavigation(page);
  await group.getByRole('button', { name: `编辑分组 ${groupName}`, exact: true }).click();
  await modal.getByLabel('分组名称', { exact: true }).fill('重新命名的分组');
  await modal.getByRole('button', { name: '阅读', exact: true }).click();
  await modal.getByRole('button', { name: '保存分组', exact: true }).click();
  const renamed = page.getByRole('region', { name: '分组 重新命名的分组', exact: true });
  await expect(renamed.locator('.lucide-book-open')).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: `管理对话 ${title}`, exact: true }).click();
  await modal.getByLabel('所属分组').selectOption('');
  await modal.getByRole('button', { name: '保存对话', exact: true }).click();
  await expect(renamed.locator('.conversation-open')).toHaveCount(1);
  await renamed.getByRole('button', { name: '编辑分组 重新命名的分组', exact: true }).click();
  await modal.getByRole('button', { name: '删除分组', exact: true }).click();
  await expect(modal).toContainText('消息会保留');
  await modal.getByRole('button', { name: '确认删除分组', exact: true }).click();
  await expect(renamed).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新建分组', exact: true })).toBeFocused();
  expect(
    (await (await request.get('/api/conversations')).json()).find(
      (c: { id: string }) => c.id === newId,
    ).groupId,
  ).toBeNull();
  expect((await request.get(`/api/conversations/${chat.id}`)).ok()).toBe(true);
  await request.delete(`/api/conversations/${newId}`);
  await request.delete(`/api/conversations/${chat.id}`);
  await request.patch('/api/preferences', { data: prefs });
});
