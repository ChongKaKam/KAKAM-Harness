import { test, expect, type Page, type Locator } from '@playwright/test';
import { chooseModel } from './controls';
import { fontSizes } from '../../src/shared/typography';
import { layoutConversation } from '../layout-fixture';
const password = 'Browser-test-password-123';
async function login(page: Page, email = 'admin@example.test') {
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
}
async function fontIs(locator: Locator, pixels: number) {
  await expect
    .poll(async () =>
      parseFloat(await locator.evaluate((element) => getComputedStyle(element).fontSize)),
    )
    .toBeCloseTo(pixels, 1);
}
async function noOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
}
async function logout(page: Page) {
  const menu = page.getByRole('button', { name: '打开导航' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
}
test('four font sizes retain hierarchy, responsive content and device-local account preferences', async ({
  page,
  browser,
}, info) => {
  await login(page);
  const id = layoutConversation(info.project.name);
  const context = page.context();
  const me = (await (await context.request.get('/api/auth/me')).json()).user;
  const sidebarWidth = await page
    .locator('.sidebar')
    .evaluate((element) => element.getBoundingClientRect().width);
  for (const size of fontSizes) {
    await page.goto('/#/settings/preferences');
    await page.getByRole('radio', { name: `${size.name} ${size.percent}`, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-font-size', size.id);
    const preview = page.locator('.font-preview');
    await fontIs(preview.locator('.markdown').first(), 16 * size.scale);
    await fontIs(preview.locator('input'), 16 * size.scale);
    await fontIs(preview.locator('pre code'), 14 * size.scale);
    await fontIs(preview.locator('td').first(), 16 * size.scale);
    await fontIs(preview.locator('.font-preview-caption'), Math.max(12, 12 * size.scale));
    await fontIs(preview.locator('.font-preview-title'), 30 * size.scale);
    await expect(preview.locator('.katex')).toBeVisible();
    await noOverflow(page);
    expect(
      await page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().width),
    ).toBe(sidebarWidth);
    await page.goto('/#/chat/' + id);
    const chat = page.getByRole('region', { name: '聊天记录', exact: true });
    await expect(chat.locator('.message')).toHaveCount(24);
    await fontIs(chat.locator('.markdown').last(), 16 * size.scale);
    await fontIs(page.getByRole('textbox', { name: '消息', exact: true }), 16 * size.scale);
    await fontIs(chat.locator('pre code').last(), 14 * size.scale);
    await fontIs(chat.locator('td').last(), 16 * size.scale);
    await expect(chat.locator('.katex-display').last()).toBeVisible();
    const last = chat.locator('.message').last();
    await expect
      .poll(
        async () =>
          (await last.evaluate((element) => element.getBoundingClientRect().bottom)) <=
          (await chat.evaluate((element) => element.getBoundingClientRect().bottom)),
      )
      .toBe(true);
    await noOverflow(page);
    await page.screenshot({ path: `test-results/font-chat-${size.id}-${info.project.name}.png` });
    await page.goto('/#/settings/users');
    await page.getByRole('button', { name: '添加用户', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await fontIs(dialog.getByLabel('邮箱', { exact: true }), 16 * size.scale);
    await fontIs(dialog.getByRole('button', { name: '保存用户' }), 14 * size.scale);
    await dialog.getByLabel('邮箱', { exact: true }).fill('layout@example.test');
    await expect(dialog.getByRole('button', { name: '保存用户' })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await noOverflow(page);
    await page.screenshot({ path: `test-results/font-modal-${size.id}-${info.project.name}.png` });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'large');
  await logout(page);
  await login(page);
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'large');
  // A second device context shares cookies but no localStorage.
  const otherDevice = await browser.newContext();
  await otherDevice.addCookies(await context.cookies());
  const otherPage = await otherDevice.newPage();
  try {
    await otherPage.goto('http://127.0.0.1:3210/');
    await expect(otherPage.locator('html')).toHaveAttribute('data-font-size', 'standard');
  } finally {
    await otherDevice.close();
  }
  const otherEmail = `font-${info.project.name}@example.test`;
  await context.request.post('/api/admin/users', {
    data: { email: otherEmail, displayName: '字号独立账户', password, role: 'user' },
  });
  await logout(page);
  await login(page, otherEmail);
  await expect(page.locator('html')).toHaveAttribute('data-font-size', 'standard');
  expect(await page.evaluate((key) => localStorage.getItem(key), `drift:font-size:${me.id}`)).toBe(
    'large',
  );
  await page.goto('/#/settings/preferences');
  await page.getByRole('radio', { name: '较大 125%', exact: true }).click();
  await page.getByRole('button', { name: '恢复默认字号' }).click();
  await page.reload();
  await expect(page.getByRole('radio', { name: '标准 100%', exact: true })).toBeChecked();
});

test('chat follows new questions and streaming, pauses while reading, and supports outline jumps', async ({
  page,
}, info) => {
  await login(page);
  const id = layoutConversation(info.project.name);
  const context = page.context();
  const provider = await (
    await context.request.post('/api/admin/providers', {
      data: {
        name: `滚动检查 ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
      },
    })
  ).json();
  const model = await (
    await context.request.post('/api/admin/models', {
      data: { providerId: provider.id, name: 'slow', label: '流式滚动测试' },
    })
  ).json();
  await page.reload();
  await page.goto('/#/chat/' + id);
  const chat = page.getByRole('region', { name: '聊天记录', exact: true });
  const outline = page.getByRole('navigation', { name: '本次对话大纲' });
  await expect(outline.getByRole('button')).toHaveCount(12);
  await expect(page.getByRole('button', { name: '回到最新消息' })).toHaveCount(0);
  const sixth = outline.getByRole('button').nth(5);
  await sixth.hover();
  await expect(page.getByRole('tooltip')).toContainText('第 6 个问题');
  await sixth.click();
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible();
  const question = chat.locator('.message.user').nth(5);
  await expect
    .poll(async () =>
      Math.abs(
        (await question.evaluate((element) => element.getBoundingClientRect().top)) -
          (await chat.evaluate((element) => element.getBoundingClientRect().top)) -
          16,
      ),
    )
    .toBeLessThan(2);
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await expect
    .poll(() =>
      chat.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(2);
  // Submitting from an old question must restore following before the accepted message arrives.
  await sixth.click();
  await chooseModel(page, { id: model.id });
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('新问题会回到底部，向上阅读时不被流式内容打断');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(outline.getByRole('button')).toHaveCount(13);
  await expect(chat.locator('.message.assistant').last()).toContainText('慢速回复');
  await expect
    .poll(() =>
      chat.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(2);
  await chat.evaluate((element) => {
    element.scrollTop -= 650;
  });
  await expect(page.getByRole('button', { name: '回到最新消息' })).toBeVisible();
  const position = await chat.evaluate((element) => element.scrollTop);
  await expect
    .poll(
      async () =>
        (await (await context.request.get(`/api/conversations/${id}`)).json()).messages.at(-1)
          .status,
    )
    .toBe('complete');
  expect(Math.abs((await chat.evaluate((element) => element.scrollTop)) - position)).toBeLessThan(
    2,
  );
  await page.screenshot({ path: `test-results/chat-reading-${info.project.name}.png` });
  await page.getByRole('button', { name: '回到最新消息' }).click();
  await expect
    .poll(() =>
      chat.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(2);
  await page.reload();
  await expect(outline.getByRole('button')).toHaveCount(13);
  await expect
    .poll(() =>
      chat.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThan(2);
  await noOverflow(page);
});
