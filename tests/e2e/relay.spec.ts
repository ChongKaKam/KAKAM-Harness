import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';

test('relay creates rendered Markdown cards, switches source, copies, edits, confirms persistence and deletes', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const title = `中转卡片 ${info.project.name}`;
  const content =
    '# 来自其他平台\n\n**重要内容**\n\n| 名称 | 数量 |\n| --- | --- |\n| 卡片 | 1 |\n\n```js\nconst answer = 42;\n```\n\n<script>window.relayUnsafe = true</script>';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#/relay');
  await expect(page.locator('.sidebar').getByRole('button', { name: /信息中转站/ })).toHaveCount(1);
  await page.getByRole('button', { name: '新建卡片', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建卡片' });
  await editor.getByRole('textbox', { name: '标题', exact: true }).fill(title);
  await editor.getByRole('textbox', { name: 'Markdown 内容' }).fill(content);
  await editor.getByRole('button', { name: '预览渲染' }).click();
  await expect(editor.getByRole('region', { name: '卡片预览' }).getByRole('table')).toBeVisible();
  await editor.getByRole('button', { name: '保存卡片' }).click();
  const card = page.getByRole('article', { name: title, exact: true });
  await expect(card.getByRole('heading', { name: '来自其他平台' })).toBeVisible();
  await expect(card.getByRole('table')).toBeVisible();
  await expect(card).toContainText('到期');
  expect(
    await page.evaluate(() => (window as Window & { relayUnsafe?: boolean }).relayUnsafe),
  ).toBeUndefined();
  await card.getByRole('button', { name: '切换为源码模式' }).click();
  await expect(card.locator('.relay-source')).toHaveText(content);
  await card.getByRole('button', { name: '复制 Markdown', exact: true }).click();
  await expect(card.getByRole('button', { name: '复制 Markdown', exact: true })).toContainText(
    '已复制',
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(content);
  await card.getByRole('button', { name: '切换为渲染模式' }).click();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑卡片' });
  await expect(edit).toContainText('编辑不会延长保留时间');
  await edit.getByRole('textbox', { name: 'Markdown 内容' }).fill(content + '\n\n新增内容');
  await edit.getByRole('button', { name: '保存卡片' }).click();
  await expect(card).toContainText('新增内容');
  await card.getByRole('button', { name: '持久化', exact: true }).click();
  await page
    .getByRole('dialog', { name: '持久化卡片' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expect(card.getByRole('button', { name: '持久化', exact: true })).toBeFocused();
  await expect(card).toContainText('到期');
  await card.getByRole('button', { name: '持久化', exact: true }).click();
  await page
    .getByRole('dialog', { name: '持久化卡片' })
    .getByRole('button', { name: '确认持久化' })
    .click();
  await expect(card).toContainText('已持久化 · 长期保留');
  await page.reload();
  await expect(card.getByRole('heading', { name: '来自其他平台' })).toBeVisible();
  await page.getByRole('button', { name: '临时', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: '已持久化', exact: true }).click();
  await expect(card).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索卡片' }).fill('不存在的关键词');
  await expect(card).toHaveCount(0);
  await page.getByRole('searchbox', { name: '搜索卡片' }).fill('新增内容');
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: `删除 ${title}` }).click();
  await page
    .getByRole('dialog', { name: '删除卡片' })
    .getByRole('button', { name: '确认删除' })
    .click();
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('relay fits light and dark themes, large type and phone with focus restoration', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const original = await (await request.get('/api/preferences')).json();
  const user = (await (await request.get('/api/auth/me')).json()).user;
  const title = `布局检查 ${info.project.name} ${'长标题'.repeat(12)}`;
  const card = await (
    await request.post('/api/relay', {
      data: {
        title,
        content: `# Markdown 内容\n\n${'长文本'.repeat(100)}\n\n| 字段 | 说明 |\n| --- | --- |\n| 名称 | ${'长单元格'.repeat(30)} |\n\n\`\`\`js\n${'constLongIdentifier'.repeat(40)}\n\`\`\``,
      },
    })
  ).json();
  try {
    for (const theme of ['light', 'dark']) {
      await request.patch('/api/preferences', { data: { ...original, theme } });
      await page.goto('/#/relay');
      await page.evaluate((id) => localStorage.setItem(`drift:font-size:${id}`, 'large'), user.id);
      await page.reload();
      const article = page.getByRole('article', { name: title });
      await expect(article).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await article.getByRole('button', { name: '切换为源码模式' }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const trigger = page.getByRole('button', { name: '新建卡片', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: '新建卡片' });
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await page.screenshot({
        path: `test-results/relay-${theme}-${info.project.name}.png`,
        fullPage: true,
      });
    }
  } finally {
    expect((await request.delete(`/api/relay/${card.id}`, { data: {} })).ok()).toBe(true);
    await request.patch('/api/preferences', { data: original });
    await page.evaluate((id) => localStorage.removeItem(`drift:font-size:${id}`), user.id);
  }
});
