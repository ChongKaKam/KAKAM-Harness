import { expect, test } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { syntaxConversation } from '../syntax-fixture';

const routes = [
  { path: '/#/chat', name: 'chat-home' },
  { path: `/#/chat/${syntaxConversation}`, name: 'chat-thread' },
  { path: '/#/prompts', name: 'skills' },
  { path: '/#/usage', name: 'usage' },
  { path: '/#/settings/preferences', name: 'preferences' },
  { path: '/#/settings/auth', name: 'account' },
  { path: '/#/settings/about', name: 'about' },
  { path: '/#/settings/models', name: 'models' },
  { path: '/#/settings/users', name: 'users' },
  { path: '/#/settings/features', name: 'features' },
  { path: '/#/settings/extensions', name: 'extensions' },
] as const;

test('Quiet Precision surfaces stay compact, readable and contained across views', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('.login-layout')).toBeVisible();
  await page.screenshot({ path: `test-results/quiet-login-${info.project.name}.png` });
  await useFixtureSession(page);
  await page.reload();
  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.locator('.shell')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await expect
      .poll(() =>
        page
          .locator('.topbar')
          .evaluate((element) => Math.round(element.getBoundingClientRect().height)),
      )
      .toBe(info.project.name === 'mobile' ? 56 : 44);
    expect(
      await page
        .locator('html')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('--radius-panel').trim()),
    ).toBe('8px');
    if (route.name === 'usage' && info.project.name === 'mobile') {
      await expect(page.locator('.usage-recent tbody')).toHaveCSS('display', 'block');
    }
    await page.screenshot({ path: `test-results/quiet-${route.name}-${info.project.name}.png` });
  }
  await page.goto('/#/settings/preferences');
  await page.getByRole('radio', { name: '黑夜' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/#/chat');
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({ path: `test-results/quiet-chat-dark-${info.project.name}.png` });
});
