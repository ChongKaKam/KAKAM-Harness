import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';

test('private artifacts preview in chat and spaces with inert source, retry and responsive themes', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const preferences = await (await request.get('/api/llm-production/preferences')).json();
  const appearance = await (await request.get('/api/preferences')).json();
  const user = (await (await request.get('/api/auth/me')).json()).user;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `预览测试 ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
      },
    })
  ).json();
  const model = await (
    await request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'production-trigger',
        label: `预览模型 ${info.project.name}`,
        toolCalling: true,
      },
    })
  ).json();
  const imageModel = await (
    await request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'production-image',
        label: `预览图片模型 ${info.project.name}`,
        kind: 'image',
      },
    })
  ).json();
  const conversation = await (await request.post('/api/conversations', { data: {} })).json();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  const imagePreviewName = '预览 · 测试图片.png';
  const imagePreview = page.getByRole('dialog', { name: imagePreviewName, exact: true });
  async function generate(prompt: string, name: string) {
    await input.fill(prompt);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(
      page.getByRole('link', { name: new RegExp(`^下载 ${name}`) }).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  }
  try {
    await request.patch('/api/llm-production/preferences', {
      data: { enabled: true, imageModelId: imageModel.id },
    });
    await page.goto(`/#/chat/${conversation.id}`);
    await chooseModel(page, { id: model.id });
    await generate('生成一张图片', '测试图片.png');
    const card = page.locator('.llm-production-message-artifacts').last();
    const thumbnail = card.getByRole('img', { name: '测试图片.png', exact: true });
    await expect(thumbnail).toBeVisible();
    await expect
      .poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
    const imageButton = card.getByRole('button', { name: '放大 测试图片.png', exact: true });
    await imageButton.click();
    await expect(imagePreview).toBeVisible();
    const enlarged = imagePreview.getByRole('img', { name: '测试图片.png', exact: true });
    await expect(enlarged).toBeVisible();
    await expect.poll(() => enlarged.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect(imagePreview.getByRole('link', { name: /下载/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(imagePreview).not.toBeVisible();
    await expect(imageButton).toBeFocused();
    const trigger = page.getByRole('button', { name: '查看当前聊天产物', exact: true });
    await trigger.click();
    const drawer = page.getByRole('dialog', { name: '聊天产物空间', exact: true });
    const libraryButton = drawer.getByRole('button', { name: '预览 测试图片.png', exact: true });
    await libraryButton.click();
    await expect(
      imagePreview.getByRole('img', { name: '测试图片.png', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeVisible();
    await expect(libraryButton).toBeFocused();
    await page.keyboard.press('Escape');
    await generate('生成一个 Markdown 文件', '测试产物.md');
    await page
      .locator('.llm-production-message-artifacts')
      .last()
      .getByRole('button', { name: '预览 测试产物.md', exact: true })
      .click();
    const markdown = page.getByRole('dialog', { name: '预览 · 测试产物.md', exact: true });
    await expect(markdown.getByRole('heading', { name: '生成产物', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await generate('帮我生成一个网页', '计算器.html');
    const artifacts = await (
      await request.get(`/api/llm-production/artifacts?conversationId=${conversation.id}`)
    ).json();
    const htmlArtifact = artifacts.artifacts.find(
      (artifact: { name: string }) => artifact.name === '计算器.html',
    );
    const htmlURL = `**/api/llm-production/artifacts/${htmlArtifact.id}/content`;
    await page.route(htmlURL, (route) =>
      route.fulfill({
        contentType: 'text/plain; charset=utf-8',
        body:
          '<script>window.previewExecuted = true</script><img src="https://example.test/tracker">' +
          '长'.repeat(100010),
      }),
    );
    await page
      .locator('.llm-production-message-artifacts')
      .last()
      .getByRole('button', { name: '预览 计算器.html', exact: true })
      .click();
    const source = page.getByRole('dialog', { name: '预览 · 计算器.html', exact: true });
    await expect(source.locator('pre')).toContainText(
      '<script>window.previewExecuted = true</script>',
    );
    await expect(source).toContainText('仅预览前 100,000 个字符');
    expect(
      await page.evaluate(() => (window as Window & { previewExecuted?: boolean }).previewExecuted),
    ).toBeUndefined();
    await expect(source.locator('iframe, script, img')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.unroute(htmlURL);
    await page.goto('/#/llm-production');
    const managerButton = page.getByRole('button', { name: '预览 测试图片.png', exact: true });
    let fail = true;
    const imageArtifact = artifacts.artifacts.find(
      (artifact: { name: string }) => artifact.name === '测试图片.png',
    );
    const imageURL = `**/api/llm-production/artifacts/${imageArtifact.id}/content`;
    await page.route(imageURL, (route) =>
      fail
        ? route.fulfill({ status: 404, json: { error: '产物不存在或已到期' } })
        : route.continue(),
    );
    await managerButton.click();
    await expect(imagePreview.getByRole('alert')).toContainText('已到期');
    fail = false;
    await imagePreview.getByRole('button', { name: /重试|重新加载/ }).click();
    await expect(
      imagePreview.getByRole('img', { name: '测试图片.png', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.unroute(imageURL);
    for (const theme of ['light', 'dark']) {
      await request.patch('/api/preferences', { data: { ...appearance, theme } });
      await page.evaluate((id) => localStorage.setItem(`drift:font-size:${id}`, 'large'), user.id);
      await page.reload();
      await managerButton.click();
      await expect(
        imagePreview.getByRole('img', { name: '测试图片.png', exact: true }),
      ).toBeVisible();
      const bounds = (await imagePreview.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
      expect(
        await imagePreview.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`production-preview-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(managerButton).toBeFocused();
    }
    expect(errors).toEqual([]);
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await request.patch('/api/llm-production/preferences', { data: preferences });
    await request.patch('/api/preferences', { data: appearance });
    await page.evaluate((id) => localStorage.removeItem(`drift:font-size:${id}`), user.id);
    expect((await request.delete(`/api/conversations/${conversation.id}`, { data: {} })).ok()).toBe(
      true,
    );
    expect((await request.delete(`/api/admin/providers/${provider.id}`, { data: {} })).ok()).toBe(
      true,
    );
  }
});
