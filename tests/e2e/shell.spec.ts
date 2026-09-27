import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { syntaxCode, syntaxConversation } from '../syntax-fixture';
import { chooseModel, chooseEffort } from './controls';
import { fontSizes } from '../../src/shared/typography';

let cookies: Awaited<ReturnType<APIRequestContext['storageState']>>['cookies'];
test.beforeAll(async ({ request }) => {
  // Layout checks share one valid session per project; login behavior is covered in workspace.spec.
  const response = await request.post('/api/auth/login', {
    data: { email: 'admin@example.test', password: 'Browser-test-password-123' },
  });
  expect(response.ok()).toBe(true);
  cookies = (await request.storageState()).cookies;
});
async function openWorkspace(page: Page) {
  await page.context().addCookies(cookies);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
}

test('personal avatar upload, decoding, account isolation and reset', async ({ page }, info) => {
  await openWorkspace(page);
  await page.goto('/#/settings/auth');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 100;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#e2ac82';
    ctx.fillRect(0, 0, 200, 100);
    ctx.fillStyle = '#557fa8';
    ctx.fillRect(60, 15, 60, 70);
    return canvas.toDataURL();
  });
  const upload = page.getByLabel('上传个人头像');
  await upload.setInputFiles({
    name: 'my-photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from(image.split(',')[1], 'base64'),
  });
  const avatar = page.locator('.account-panel .user-avatar img');
  await expect(avatar).toBeVisible();
  await expect
    .poll(() => avatar.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBe(100);
  const saved = (await (await page.context().request.get('/api/auth/me')).json()).user.avatar;
  expect(saved).toMatch(/^data:image\/(webp|png|jpeg);base64,/);
  await expect(page.locator('.sidebar .user-avatar img')).toHaveAttribute('src', saved);
  await upload.setInputFiles({
    name: 'broken.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not an image'),
  });
  await expect(page.getByRole('alert')).toContainText('图片无法解码');
  await expect(avatar).toHaveAttribute('src', saved);
  await page.reload();
  await expect(avatar).toHaveAttribute('src', saved);
  await page.screenshot({
    path: `test-results/personal-avatar-${info.project.name}.png`,
    fullPage: true,
  });
  await page.goto('/#/chat/' + syntaxConversation);
  await expect(page.locator('.message.user .user-avatar img')).toHaveAttribute('src', saved);
  await page.goto('/#/settings/auth');
  await page.getByRole('button', { name: '恢复默认头像', exact: true }).click();
  await expect(page.locator('.user-avatar img')).toHaveCount(0);
  expect((await (await page.context().request.get('/api/auth/me')).json()).user.avatar).toBeNull();
});

test('compact combined picker supports model search, keyboard effort and per-model persistence', async ({
  page,
}, info) => {
  await openWorkspace(page);
  const request = page.context().request;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `Picker ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'test',
      },
    })
  ).json();
  const models = [];
  for (const [name, label] of [
    ['test-vision', 'A model with a long readable label'],
    ['second', `Second model ${info.project.name}`],
  ]) {
    const response = await request.post('/api/admin/models', {
      data: { providerId: provider.id, name, label },
    });
    expect(response.ok()).toBe(true);
    models.push(await response.json());
  }
  await page.reload();
  await chooseModel(page, { id: models[0].id });
  const trigger = page.getByRole('button', { name: /^模型与思考程度：/ });
  await trigger.click();
  const slider = page.getByRole('slider', { name: '思考程度', exact: true });
  await slider.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Medium · 中');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('中');
  await chooseModel(page, { id: models[1].id });
  await expect(trigger).toContainText('默认');
  await chooseEffort(page, 'High');
  await chooseModel(page, { id: models[0].id });
  await expect(trigger).toContainText('中');
  await page.reload();
  await expect(trigger).toContainText('中');
  await trigger.click();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索模型' }).fill('not-present');
  await expect(page.getByText('没有匹配的模型')).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索模型' }).fill(`Second model ${info.project.name}`);
  await expect(page.getByRole('radiogroup', { name: '可用模型' }).getByRole('radio')).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: '关闭模型设置' }).click();
  for (const size of fontSizes) {
    await page.goto('/#/settings/preferences');
    await page.getByRole('radio', { name: `${size.name} ${size.percent}`, exact: true }).click();
    await page.goto('/#/chat');
    await trigger.click();
    const panel = page.getByRole('dialog', { name: '模型与思考设置' });
    const bounds = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    const tools = await page.locator('.composer-tools').boundingBox();
    expect(tools!.height).toBeLessThan(55);
    await page.screenshot({
      path: `test-results/model-picker-${size.id}-${info.project.name}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    await expect(
      page.getByRole('radiogroup', { name: '可用模型' }).getByRole('radio').first(),
    ).toBeVisible();
    if (size.id === 'standard')
      await page.screenshot({
        path: `test-results/model-list-${info.project.name}.png`,
        fullPage: true,
      });
    // The anchored popover may cover the editor; use an unobscured shell corner for light dismiss.
    await page.locator('.topbar').click({ position: { x: 4, y: 4 } });
    await expect(panel).toHaveCount(0);
  }
  await page.goto('/#/settings/preferences');
  await page.getByRole('button', { name: '恢复默认字号' }).click();
  await page.goto('/#/chat');
  await trigger.click();
  await page.getByRole('button', { name: '恢复默认思考程度' }).click();
  await expect(slider).toHaveValue('0');
  await page.getByRole('button', { name: '关闭模型设置' }).click();
});

test('Python syntax retains distinct token colors when the theme changes in place', async ({
  page,
}, info) => {
  await openWorkspace(page);
  await page.goto('/#/settings/preferences');
  await page.getByRole('radio', { name: '跟随系统', exact: true }).click();
  await page.goto('/#/chat/' + syntaxConversation);
  const code = page.locator('.message.assistant code.language-python');
  await expect(code).toBeVisible();
  const markup = await code.innerHTML();
  let lightColors: string[] = [];
  for (const mode of ['light', 'dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await expect(code).toHaveText(syntaxCode + '\n');
    expect(await code.innerHTML()).toBe(markup);
    const tokens = await code.evaluate((element) => {
      const base = getComputedStyle(element).color;
      const background = getComputedStyle(element.closest('pre')!).backgroundColor;
      const groups = ['keyword', 'title', 'number', 'string', 'built_in', 'comment'];
      return {
        base,
        background,
        colors: groups.map((group) => {
          const token = element.querySelector('.hljs-' + group)!;
          return getComputedStyle(token).color;
        }),
      };
    });
    expect(new Set(tokens.colors).size, `${mode}: six semantic color groups`).toBe(6);
    for (const color of tokens.colors) expect(color).not.toBe(tokens.base);
    const luminance = (color: string) => {
      const rgb = color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number)
        .map((c) => {
          const s = c / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    for (const color of [tokens.base, ...tokens.colors]) {
      const levels = [luminance(color), luminance(tokens.background)].sort((a, b) => b - a);
      expect(
        (levels[0] + 0.05) / (levels[1] + 0.05),
        `${mode}/${color} contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    if (mode === 'light') lightColors = tokens.colors;
    else tokens.colors.forEach((color, index) => expect(color).not.toBe(lightColors[index]));
    await page.screenshot({
      path: `test-results/syntax-${mode}-${info.project.name}.png`,
      fullPage: true,
    });
  }
});

test('neutral shell, sailboat, feature categories and project link adapt to both themes', async ({
  page,
}, info) => {
  await openWorkspace(page);
  for (const mode of ['light', 'dark'] as const) {
    await page.goto('/#/settings/preferences');
    await page
      .getByRole('radio', { name: mode === 'light' ? '白天' : '黑夜', exact: true })
      .click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
    await page.goto('/#/chat');
    await expect(page.locator('.hero-mark .lucide-sailboat')).toHaveCount(1);
    if (info.project.name === 'desktop') await expect(page.locator('.hero-mark')).toBeVisible();
    for (const selector of [
      '.sidebar',
      '.topbar',
      '.home-intro h1',
      '.home-intro p',
      '.model-picker-trigger',
    ]) {
      const values = await page
        .locator(selector)
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.color, style.backgroundColor, style.borderTopColor];
        });
      for (const value of values) {
        const [r, g, b] = value.match(/[\d.]+/g)!.map(Number);
        expect(r, `${mode}/${selector}/${value}`).toBe(g);
        expect(g, `${mode}/${selector}/${value}`).toBe(b);
      }
    }
    const colors = await page
      .locator('.idea-card')
      .evaluateAll((cards) => cards.map((card) => getComputedStyle(card).borderTopColor));
    expect(new Set(colors).size).toBe(3);
    await page.screenshot({
      path: `test-results/neutral-home-${mode}-${info.project.name}.png`,
      fullPage: true,
    });
    await page.goto('/#/settings/features');
    const core = page.getByRole('region', { name: /^基础能力/ });
    const plugin = page.getByRole('region', { name: /^进阶能力/ });
    await expect(core).toBeVisible();
    await expect(plugin).toBeVisible();
    await expect(core.getByRole('switch')).toHaveCount(0);
    await expect(core.getByText('始终启用', { exact: true })).toHaveCount(6);
    await expect(plugin.getByRole('switch', { name: '提示词库开关' })).toBeEnabled();
    const coreBox = (await core.boundingBox())!;
    const pluginBox = (await plugin.boundingBox())!;
    if (info.project.name === 'desktop') {
      expect(pluginBox.x).toBeGreaterThan(coreBox.x + coreBox.width);
      expect(pluginBox.y).toBe(coreBox.y);
    } else expect(pluginBox.y).toBeGreaterThan(coreBox.y + coreBox.height);
    await page.screenshot({
      path: `test-results/feature-groups-${mode}-${info.project.name}.png`,
      fullPage: true,
    });
    await page.goto('/#/settings/about');
    const source = page.getByRole('link', { name: 'ChongKaKam/KAKAM-Harness' });
    await expect(source).toHaveAttribute('href', 'https://github.com/ChongKaKam/KAKAM-Harness');
    await expect(source).toHaveAttribute('target', '_blank');
    await expect(source).toHaveAttribute('rel', 'noopener noreferrer');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: `test-results/about-${mode}-${info.project.name}.png`,
      fullPage: true,
    });
  }
});
