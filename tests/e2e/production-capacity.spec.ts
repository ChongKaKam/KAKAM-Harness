import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';

test('administrator capacity settings persist and ordinary accounts only see the applied limit', async ({
  page,
  browser,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const path = '/api/admin/llm-production/settings';
  const original = await (await request.get(path)).json();
  const capacity = page.getByRole('spinbutton', { name: '每账户产物容量（MiB）', exact: true });
  const save = page.getByRole('button', { name: '保存容量设置', exact: true });
  const member = await browser.newContext({ baseURL: 'http://127.0.0.1:3210' });
  try {
    await page.goto('/#/settings/preferences');
    await page
      .getByRole('navigation', { name: '设置分类', exact: true })
      .getByRole('button', { name: '产物容量', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: '产物容量', exact: true })).toBeVisible();
    await expect(capacity).toHaveValue(String(original.accountLimitMiB));
    await capacity.fill('0');
    await expect(save).toBeDisabled();
    await capacity.fill('2048');
    await save.click();
    await expect(page.getByRole('status')).toContainText('对所有账户立即生效');
    await page.reload();
    await expect(capacity).toHaveValue('2048');
    expect(
      (await (await request.get('/api/llm-production/settings')).json()).storage.limitBytes,
    ).toBe(2 * 1024 ** 3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('production-capacity-admin.png'),
      fullPage: true,
    });
    await page.goto('/#/settings/llm-production');
    await expect(page.locator('.llm-production-storage-label')).toContainText('上限 2.0 GiB');
    const email = `capacity-${info.project.name}-${Date.now()}@example.test`;
    const password = 'capacity-fixture';
    expect(
      (
        await request.post('/api/admin/users', {
          data: { email, displayName: '容量普通账户', password, role: 'user' },
        })
      ).ok(),
    ).toBe(true);
    expect((await member.request.post('/api/auth/login', { data: { email, password } })).ok()).toBe(
      true,
    );
    expect((await member.request.get(path)).status()).toBe(403);
    expect((await member.request.patch(path, { data: { accountLimitMiB: 4096 } })).status()).toBe(
      403,
    );
    const memberPage = await member.newPage();
    await memberPage.goto('/#/settings/llm-production');
    await expect(memberPage.locator('.llm-production-storage-label')).toContainText('上限 2.0 GiB');
    await expect(memberPage.getByRole('button', { name: '产物容量', exact: true })).toHaveCount(0);
    await memberPage.goto('/#/settings/admin:llm-production');
    await expect(
      memberPage.getByRole('heading', { name: '此设置不可用', exact: true }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole('spinbutton', { name: '每账户产物容量（MiB）', exact: true }),
    ).toHaveCount(0);
  } finally {
    await member.close();
    expect((await request.patch(path, { data: original })).ok()).toBe(true);
  }
});
