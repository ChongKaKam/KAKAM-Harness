import { expect, test } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';

test('administrator saves an upstream key and installs or revokes a device key', async ({
  page,
  baseURL,
}) => {
  await useFixtureSession(page);
  const officialOrigin = 'https://drift.kakamlab.com';
  const command = `curl -fsSL ${officialOrigin}/install.sh | bash`;
  // Render the official-site UI entirely through the local test server.
  await page.route(`${officialOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await page.request.get(new URL(url.pathname + url.search, baseURL).href);
    await route.fulfill({ response });
  });
  const deviceKey = 'dsk_' + 'a'.repeat(43);
  let configured = false;
  let issued = false;
  await page.route('**/api/admin/openai-gateway', (route) =>
    route.fulfill({
      json: {
        configured,
        keys: issued
          ? [{ id: 'device', name: '开发机', prefix: deviceKey.slice(0, 12), createdAt: 1 }]
          : [],
      },
    }),
  );
  await page.route('**/api/admin/openai-gateway/config', (route) => {
    expect(route.request().method()).toBe('PUT');
    expect(route.request().postDataJSON()).toEqual({ apiKey: 'fixture-upstream' });
    configured = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/admin/openai-gateway/keys', (route) => {
    expect(route.request().postDataJSON()).toEqual({ name: '开发机' });
    issued = true;
    return route.fulfill({ status: 201, json: { key: deviceKey } });
  });
  await page.route('**/api/admin/openai-gateway/keys/device', (route) => {
    expect(route.request().method()).toBe('DELETE');
    issued = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/settings/openai-gateway');
  await expect(page.getByRole('heading', { name: '开发机接入' })).toBeVisible();
  await expect(page.getByRole('button', { name: '复制配置命令' })).toHaveCount(0);
  await page.goto(`${officialOrigin}/#/settings/openai-gateway`);
  await expect(page.getByText(command, { exact: true })).toBeVisible();

  await page.getByLabel('OpenAI API 密钥', { exact: true }).fill('fixture-upstream');
  await page.getByRole('button', { name: '保存 OpenAI 密钥' }).click();
  await expect(page.getByLabel('新的 OpenAI API 密钥')).toBeEmpty();
  await page.getByLabel('设备名称').fill('开发机');
  await page.getByRole('button', { name: '签发设备密钥' }).click();
  const dialog = page.getByRole('dialog', { name: '保存设备密钥并配置 Codex' });
  await expect(dialog.getByLabel('开发机转发密钥')).toHaveValue(deviceKey);
  await expect(dialog.getByText(command, { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.body.dataset.clipboard = text;
        },
      },
    });
  });
  await dialog.getByRole('button', { name: '复制配置命令' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-clipboard', command);
  await expect(dialog.getByRole('button', { name: '配置命令已复制' })).toBeVisible();
  await dialog.getByText('使用独立启动器 codex-drift').click();
  await dialog.getByText('在远端终端粘贴安装').click();
  const pasteScript = await dialog.getByLabel('终端安装脚本').inputValue();
  expect(pasteScript).toContain('</dev/tty');
  expect(pasteScript).not.toContain(deviceKey);
  await dialog.getByRole('button', { name: '复制安装脚本' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-clipboard', pasteScript);
  await expect(dialog.getByRole('status')).toHaveText('安装脚本已复制');
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载已配置脚本' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('install-codex-drift.sh');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const contents = Buffer.concat(chunks).toString();
  expect(contents).toContain(deviceKey);
  expect(contents).not.toContain('fixture-upstream');
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(page.getByLabel('开发机转发密钥')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销 开发机' }).click();
  await page.getByRole('button', { name: '确认撤销' }).click();
  await expect(page.getByText('尚未签发开发机密钥。')).toBeVisible();
});
