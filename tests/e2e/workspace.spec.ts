import { test, expect, type Page } from '@playwright/test';
import { chooseModel, chooseEffort } from './controls';
import { imageData } from '../mock-provider';
import { colorPatterns } from '../../src/shared/appearance';
const password = 'Browser-test-password-123';
async function login(page: Page, username = 'admin') {
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill(`${username}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入工作区' }).click();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
}
async function nav(page: Page, name: string) {
  const settings = ['用户管理', '模型与接入', '功能与插件', '通用设置', '账户设置', '相关信息'];
  if (
    settings.includes(name) &&
    (await page.getByRole('navigation', { name: '设置分类' }).count())
  ) {
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name, exact: true })
      .click();
    return;
  }
  const menu = page.getByRole('button', { name: '打开导航' });
  if (await menu.isVisible()) await menu.click();
  if (settings.includes(name)) {
    await page.getByRole('button', { name: '打开设置' }).click();
    await page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name, exact: true })
      .click();
  } else
    await page
      .locator('.sidebar')
      .getByRole('button', { name: new RegExp(`^${name}( 插件)?$`) })
      .click();
}
async function pasteMarkdown(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.focus();
  await input.evaluate((element, content) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', content);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  }, text);
}
test('administrator setup, rich multimodal chat, user authorization and plugin lifecycle', async ({
  page,
}, info) => {
  const suffix = info.project.name;
  const sourceName = `测试来源 ${suffix}`;
  const username = `reader-${suffix}`;
  const modelLabel = `Vision ${suffix}`;
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await login(page);
  await page.screenshot({ path: `test-results/home-${suffix}.png`, fullPage: true });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await expect(page.getByRole('navigation', { name: '工作区' }).getByRole('button')).toHaveCount(2);
  await expect(
    page.getByRole('navigation', { name: '统计' }).getByRole('button', { name: '用量统计' }),
  ).toHaveCount(1);
  await expect(
    page.locator('.sidebar').getByRole('button', { name: '用户管理', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('.sidebar').getByRole('button', { name: '界面设置', exact: true }),
  ).toHaveCount(0);
  await nav(page, '用户管理');
  await page.getByRole('button', { name: '添加用户', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(`${username}@example.test`);
  await page.getByLabel('显示名称').fill(`阅读者 ${suffix}`);
  await page.getByLabel('初始密码').fill(password);
  await page.getByRole('button', { name: '保存用户' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await nav(page, '模型与接入');
  await page.getByRole('button', { name: '添加来源' }).click();
  await page.getByLabel('来源名称').fill(sourceName);
  await page.getByLabel('Base URL').fill('http://127.0.0.1:3211/v1');
  await page.getByLabel('API Key').fill('test-secret');
  await page
    .getByLabel('响应模式')
    .selectOption(suffix === 'desktop' ? 'responses' : 'chat-completions');
  await page.getByRole('dialog').getByRole('button', { name: '探测模型' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('发现 6 个模型');
  await expect(page.getByRole('dialog').getByRole('button', { name: '测试连通性' })).toHaveCount(0);
  await page.getByRole('button', { name: '保存来源' }).click();
  await expect(page.getByRole('dialog')).toContainText('探测结果');
  await page
    .locator('.discovery-list>.row')
    .filter({ hasText: /^test-vision添加$/ })
    .getByRole('button', { name: '添加', exact: true })
    .click();
  await expect(
    page
      .locator('.discovery-list>.row')
      .filter({ hasText: 'test-vision' })
      .getByRole('button', { name: '已添加' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: /模型管理与授权/ }).click();
  const row = page.getByRole('row').filter({ hasText: sourceName });
  await row.getByRole('button', { name: '管理', exact: true }).click();
  await page.getByRole('button', { name: '测试连通性' }).click();
  await expect(page.locator('.models-probe-result')).toContainText('连接成功');
  await expect(page.locator('.models-probe-result')).toContainText('首段文本');
  await expect(page.locator('.models-probe-result')).toContainText('总耗时');
  await page.getByLabel('显示名称').fill(modelLabel);
  await page.getByLabel('支持图片输入').check();
  await page.getByRole('checkbox', { name: new RegExp(username) }).check();
  await page.getByRole('button', { name: '保存模型' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: `test-results/models-${suffix}.png`, fullPage: true });
  await nav(page, '通用设置');
  await page.getByRole('radio', { name: '黑夜', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('input[type=file]').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from(imageData.split(',')[1], 'base64'),
  });
  await expect(page.locator('.avatar-setting').getByAltText('Chatbot 头像')).toBeVisible();
  await expect(page.getByRole('button', { name: '上传图标' })).toBeEnabled();
  await page.getByRole('heading', { name: '通用设置' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/settings-${suffix}.png`, fullPage: true });
  await nav(page, '对话');
  await chooseModel(page, { label: `${modelLabel} · ${sourceName}` });
  await chooseEffort(page, 'Extra high');
  await page.locator('input[type=file]').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(imageData.split(',')[1], 'base64'),
  });
  await pasteMarkdown(page, '请解释这张图片。**加粗**与公式：\\(x^2\\)');
  await expect(page.getByRole('tab', { name: '预览', exact: true })).toHaveCount(0);
  await expect(page.locator('.live-composer .katex')).toBeVisible();
  await expect(page.locator('.live-composer strong')).toHaveText('加粗');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();
  await expect(page.locator('.message.assistant table')).toBeVisible();
  await expect(page.locator('.message.assistant .katex').first()).toBeVisible();
  await expect(page.locator('.message.assistant .latex-preview .katex-display')).toBeVisible();
  await page.getByRole('button', { name: '复制代码', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '复制代码', exact: true }).first()).toHaveText(
    '已复制',
  );
  // Updating the composer must not remount existing Markdown and erase copy feedback.
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('继续输入');
  await expect(page.getByRole('button', { name: '复制代码', exact: true }).first()).toHaveText(
    '已复制',
  );
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('');
  await expect(page.locator('.message.assistant .assistant-avatar img')).toBeVisible();
  await expect(page.locator('.message.assistant .mermaid svg')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.message.assistant .hljs-keyword').first()).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked),
  ).toBeUndefined();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `test-results/chat-${suffix}.png`, fullPage: true });
  await page.reload();
  await expect(page.locator('.message.assistant .mermaid svg')).toBeVisible();
  await expect(page.getByRole('button', { name: /^模型与思考程度：/ })).toContainText('极高');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await nav(page, '用量统计');
  await expect(page.getByText('未上报用量', { exact: false })).toBeVisible();
  await expect(page.getByRole('cell', { name: modelLabel, exact: true })).toBeVisible();
  await expect(page.getByLabel('Token 活动热力图').locator('button')).toHaveCount(365);
  await page.getByRole('button', { name: '每周', exact: true }).click();
  await expect(page.getByLabel('Token 活动热力图').locator('button')).toHaveCount(53);
  await page.getByRole('button', { name: '累计', exact: true }).click();
  await expect(page.getByLabel('Token 活动热力图').locator('button')).toHaveCount(365);
  await page.getByRole('button', { name: '每日', exact: true }).click();
  if (suffix === 'mobile')
    await expect
      .poll(() => page.locator('.activity-scroll').evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
  await page.screenshot({ path: `test-results/usage-${suffix}.png`, fullPage: true });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await nav(page, '通用设置');
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(page.getByAltText('Chatbot 头像')).toHaveCount(0);
  await page.getByRole('radio', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: '白天', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await nav(page, '功能与插件');
  await page.getByRole('switch', { name: '提示词库开关' }).click();
  await expect(page.getByRole('switch', { name: '提示词库开关' })).not.toBeChecked();
  await page.getByRole('switch', { name: '提示词库开关' }).click();
  await expect(page.getByRole('switch', { name: '提示词库开关' })).toBeChecked();
  const menu = page.getByRole('button', { name: '打开导航' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '进入工作区' })).toBeVisible();
  await login(page, username);
  await chooseModel(page, { label: `${modelLabel} · ${sourceName}` });
  if (await menu.isVisible()) await menu.click();
  await expect(page.getByRole('button', { name: '用户管理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '模型与接入', exact: true })).toHaveCount(0);
  if (await page.getByRole('button', { name: '收起导航' }).isVisible())
    await page.getByRole('button', { name: '收起导航' }).click();
  await nav(page, '提示词库');
  await page.getByRole('button', { name: '新建提示词' }).click();
  await page.getByLabel('名称', { exact: true }).fill('我的学习伙伴');
  await page.getByLabel('提示词内容').fill('帮我理解一个概念');
  await page.getByRole('button', { name: '保存提示词' }).click();
  await page.getByRole('button', { name: '用于新对话' }).click();
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveText(
    '帮我理解一个概念',
  );
  expect(pageErrors).toEqual([]);
});

test('public registration enters a private member workspace', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '没有账户？立即注册' }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(`signup-${info.project.name}@example.test`);
  await page.getByLabel('显示名称').fill('新朋友');
  await page.getByLabel('密码', { exact: true }).fill('1');
  await page.getByRole('button', { name: '注册并进入' }).click();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeDisabled();
  await expect(page.getByText('还没有向你授权的模型，请联系管理员。')).toBeVisible();
  await expect(page.getByRole('button', { name: '用户管理', exact: true })).toHaveCount(0);
  await nav(page, '通用设置');
  await expect(
    page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '用户管理', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('radio', { name: '跟随系统', exact: true })).toBeChecked();
  await expect(page.getByRole('tab', { name: '自然鲜明', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByAltText('Chatbot 头像')).toHaveCount(0);
});

test('live composer supports typing, undo, math editing, paste, IME and Markdown submission', async ({
  page,
}, info) => {
  await login(page);
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.click();
  await input.pressSequentially('**live**');
  await expect(input.locator('strong')).toHaveText('live');
  await page.getByRole('button', { name: '撤销编辑' }).click();
  await expect(input.locator('strong')).toHaveCount(0);
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await input.pressSequentially('$x^2$');
  await expect(input.locator('.katex')).toBeVisible();
  await input.locator('[data-type="inline-math"]').click();
  await page.getByLabel('LaTeX 公式', { exact: true }).fill('x^3');
  await page.getByRole('button', { name: '应用公式' }).click();
  await expect(input.locator('[data-latex="x^3"]')).toBeVisible();
  await expect(input).toBeFocused();
  await pasteMarkdown(
    page,
    '\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```javascript\nconst answer = 42;\n```\n\n```mermaid\ngraph LR\n A-->B\n```',
  );
  await expect(input.locator('table')).toBeVisible();
  await expect(input.locator('[data-latex="x^3"]')).toBeVisible();
  await expect(input.locator('.mermaid svg')).toBeVisible();
  await expect(input.locator('pre').filter({ hasText: 'const answer = 42;' })).toBeVisible();
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 229,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
  });
  await expect(page.locator('.message.assistant')).toHaveCount(0);
  await page.screenshot({
    path: `test-results/live-composer-${info.project.name}.png`,
    fullPage: true,
  });
  const sent = page.waitForRequest(
    (request) => request.url().endsWith('/messages') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: '发送消息' }).click();
  const body = (await sent).postDataJSON();
  expect(body.content).toContain('$x^3$');
  expect(body.content).toMatch(/\| A\s+\| B\s+\|/);
  expect(body.content).toContain('```javascript\nconst answer = 42;');
  expect(body.content).toContain('```mermaid');
  await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();
  await expect(input).toHaveText('');
  await nav(page, '相关信息');
  await expect(page.getByRole('heading', { name: '相关信息', exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole('navigation', { name: '设置分类' })
      .getByRole('button', { name: '相关信息', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await nav(page, '账户设置');
  await expect(page.getByRole('heading', { name: '账户设置', exact: true })).toBeVisible();
});

test('Color Pattern tabs keep shell neutral, color components and persist per account', async ({
  page,
}, info) => {
  await login(page);
  await nav(page, '通用设置');
  const tabs = page.getByRole('tablist', { name: 'Color Pattern' });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  for (const [mode, name] of [
    ['light', '白天'],
    ['dark', '黑夜'],
  ] as const) {
    await page.getByRole('radio', { name, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    let baseline: unknown;
    for (const pattern of colorPatterns.list()) {
      await tabs.getByRole('tab', { name: pattern.name }).click();
      await expect(tabs.getByRole('tab', { name: pattern.name })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.locator('html')).toHaveAttribute('data-color-pattern', pattern.id);
      await expect(page.getByRole('tabpanel').locator('.pattern-color')).toHaveCount(9);
      const neutral = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ['--ink', '--muted', '--faint', '--surface', '--sidebar'].map((key) =>
          style.getPropertyValue(key),
        );
      });
      if (baseline) expect(neutral).toEqual(baseline);
      baseline = neutral;
      const textColors = await page.locator('.font-preview').evaluate((element) => {
        const title = getComputedStyle(element.querySelector('.font-preview-title')!).color;
        const th = getComputedStyle(element.querySelector('th')!).color;
        const hint = getComputedStyle(
          element.querySelector('.message-author > span:last-child')!,
        ).color;
        return [title, th, hint];
      });
      for (const color of textColors) {
        const [r, g, b] = color.match(/\d+/g)!.map(Number);
        expect(r).toBeGreaterThanOrEqual(g);
        expect(g).toBeGreaterThanOrEqual(b);
      }
      const fills = await page
        .locator('.pattern-preview-grid .pattern-card')
        .evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).backgroundColor),
        );
      expect(new Set(fills).size).toBe(3);
      await page
        .getByRole('heading', { name: 'Color Pattern', exact: true })
        .scrollIntoViewIfNeeded();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await page.screenshot({
        path: `test-results/pattern-${pattern.id}-${mode}-${info.project.name}.png`,
      });
    }
  }
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-color-pattern', 'classic');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await tabs.getByRole('tab', { name: '柔和经典' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.getByRole('tab', { name: '自然鲜明' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('radio', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const menu = page.getByRole('button', { name: '打开导航' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: '退出登录' }).click();
  await login(page, `reader-${info.project.name}`);
  await expect(page.locator('html')).toHaveAttribute('data-color-pattern', 'natural');
});

test('conversation and prompt colors can be assigned, remapped and reset without unstable recoloring', async ({
  page,
}, info) => {
  await login(page);
  const request = page.context().request;
  const prefs = await (await request.get('/api/preferences')).json();
  await request.patch('/api/preferences', {
    data: { ...prefs, colorPattern: 'natural', theme: 'light' },
  });
  const created = await request.post('/api/conversations', { data: {} });
  expect(created.ok()).toBe(true);
  const conversation = await created.json();
  const title = `配色对话 ${info.project.name}`;
  await request.patch(`/api/conversations/${conversation.id}`, { data: { title } });
  const prompt = await (
    await request.post('/api/prompts', {
      data: { title: `配色卡片 ${info.project.name}`, content: '整理我的学习笔记' },
    })
  ).json();
  await page.reload();
  await expect(page.locator('.idea-card')).toHaveCount(3);
  const fills = await page
    .locator('.idea-card')
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).backgroundColor),
    );
  expect(new Set(fills).size).toBe(3);
  await page.reload();
  await expect
    .poll(() =>
      page
        .locator('.idea-card')
        .evaluateAll((elements) =>
          elements.map((element) => getComputedStyle(element).backgroundColor),
        ),
    )
    .toEqual(fills);
  await page.screenshot({ path: `test-results/pattern-home-${info.project.name}.png` });
  const menu = page.getByRole('button', { name: '打开导航' });
  if (await menu.isVisible()) await menu.click();
  const row = page.locator('.conversation-link').filter({ hasText: title });
  await row.hover();
  await row.getByRole('button', { name: `设置颜色 ${title}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('radio', { name: '湖水蓝', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('radio', { name: '湖水蓝', exact: true }),
  ).toBeChecked();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  expect(
    (await (await request.get('/api/conversations')).json()).find(
      (item: { id: string }) => item.id === conversation.id,
    ).colorSlot,
  ).toBe(6);
  const closeMenu = page.getByRole('button', { name: '收起导航' });
  if (await closeMenu.isVisible()) await closeMenu.click();
  await nav(page, '提示词库');
  const card = page.locator('.prompt-card').filter({ hasText: `配色卡片 ${info.project.name}` });
  await card.getByRole('button', { name: /设置颜色/ }).click();
  await page.getByRole('dialog').getByRole('radio', { name: '玫瑰粉', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('radio', { name: '玫瑰粉', exact: true }),
  ).toBeChecked();
  await page.screenshot({ path: `test-results/pattern-picker-${info.project.name}.png` });
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await nav(page, '通用设置');
  await page.getByRole('tab', { name: '柔和经典' }).click();
  await expect(page.getByRole('tab', { name: '柔和经典' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.reload();
  await nav(page, '提示词库');
  await expect
    .poll(() => card.evaluate((element) => element.style.getPropertyValue('--item-color')))
    .toBe('#f0c9d1');
  await card.getByRole('button', { name: /设置颜色/ }).click();
  await expect(
    page.getByRole('dialog').getByRole('radio', { name: '柔粉', exact: true }),
  ).toBeChecked();
  await page.getByRole('button', { name: '恢复自动配色' }).click();
  await expect(page.getByRole('button', { name: '恢复自动配色' })).toBeDisabled();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  expect(
    (await (await request.get('/api/prompts')).json()).find(
      (item: { id: string }) => item.id === prompt.id,
    ).colorSlot,
  ).toBe(null);
  if (await menu.isVisible()) await menu.click();
  await expect
    .poll(() => row.evaluate((element) => element.style.getPropertyValue('--item-color')))
    .toBe('#98b9ca');
  await row.hover();
  await row.getByRole('button', { name: `设置颜色 ${title}`, exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('radio', { name: '蓝灰', exact: true }),
  ).toBeChecked();
  await page.getByRole('button', { name: '恢复自动配色' }).click();
  await expect(page.getByRole('button', { name: '恢复自动配色' })).toBeDisabled();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
});

test('legacy account binds an email and keeps its display name', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '旧账户绑定邮箱', exact: true }).click();
  await page.getByLabel('旧用户名', { exact: true }).fill(`old-${info.project.name}`);
  await page.getByLabel('邮箱', { exact: true }).fill(`migrated-${info.project.name}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '绑定邮箱并登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  await nav(page, '账户设置');
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(
    `migrated-${info.project.name}@example.test`,
  );
  await expect(page.getByLabel('显示名称', { exact: true })).toHaveValue(
    `迁移测试 ${info.project.name}`,
  );
});

test('chat survives navigation, offline suspension and tab closure; resumed jobs can still be stopped', async ({
  page,
}, info) => {
  await login(page);
  const context = page.context();
  const providers = await (await context.request.get('/api/admin/providers')).json();
  const provider = providers.find(
    (item: { name: string }) => item.name === `测试来源 ${info.project.name}`,
  );
  const modelResponse = await context.request.post('/api/admin/models', {
    data: { providerId: provider.id, name: 'slow', label: `后台模型 ${info.project.name}` },
  });
  expect(modelResponse.status()).toBe(201);
  const model = await modelResponse.json();
  await page.reload();
  await chooseModel(page, { id: model.id });
  let submits = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/messages')) submits++;
  });
  async function send(text: string) {
    await pasteMarkdown(page, text);
    const accepted = page.waitForResponse(
      (response) => response.url().endsWith('/messages') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    expect((await accepted).status()).toBe(202);
    await expect(page.locator('.message.assistant').last()).toContainText('慢速回复');
  }
  const saved = async (id: string) =>
    (await (await context.request.get(`/api/conversations/${id}`)).json()).messages;
  await send('离开页面后继续');
  const chatUrl = page.url();
  const id = chatUrl.split('/').at(-1)!;
  await nav(page, '相关信息');
  await expect.poll(async () => (await saved(id)).at(-1).status).toBe('complete');
  await page.goto(chatUrl);
  await expect(page.getByRole('button', { name: '复制回复' })).toHaveCount(1);
  expect((await saved(id)).at(-1).content).toBe('慢速回复 '.repeat(50));
  await send('断网后继续');
  await context.setOffline(true);
  await expect(
    page.getByText('连接恢复后会自动同步；已提交的回复仍在服务器上继续生成。'),
  ).toBeVisible();
  try {
    await expect.poll(async () => (await saved(id)).at(-1).status).toBe('complete');
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByRole('button', { name: '复制回复' })).toHaveCount(2);
  expect((await saved(id)).length).toBe(4);
  await send('关掉标签页后仍可恢复和停止');
  await page.close();
  const returned = await context.newPage();
  try {
    await returned.goto(chatUrl);
    await expect(returned.getByRole('button', { name: '停止生成' })).toBeEnabled();
    await returned.getByRole('button', { name: '停止生成' }).click();
    await expect.poll(async () => (await saved(id)).at(-1).status).toBe('cancelled');
    await expect(returned.getByRole('button', { name: '发送消息' })).toBeVisible();
    expect((await saved(id)).length).toBe(6);
    expect(submits).toBe(3);
    await returned.screenshot({
      path: `test-results/resumed-chat-${info.project.name}.png`,
      fullPage: true,
    });
  } finally {
    await returned.close();
  }
});
