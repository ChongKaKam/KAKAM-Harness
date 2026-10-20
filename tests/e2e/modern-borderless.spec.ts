import { expect, test, type Locator } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { syntaxConversation } from '../syntax-fixture';

const routes = [
  { path: '/#/chat', name: 'chat-home', ready: '.composer' },
  {
    path: `/#/chat/${syntaxConversation}`,
    name: 'chat-thread',
    ready: '.message.assistant',
  },
  { path: '/#/prompts', name: 'skills', ready: '.prompts-page' },
  { path: '/#/usage', name: 'usage', ready: '.stats-grid' },
  { path: '/#/settings/preferences', name: 'preferences', ready: '.font-settings' },
  { path: '/#/settings/models', name: 'models', ready: '.settings-content .page-heading' },
] as const;

async function expectBorderlessSurface(surface: Locator) {
  await expect(surface).toHaveCSS('border-width', '0px');
  await expect(surface).not.toHaveCSS('box-shadow', 'none');
}

test('Modern Borderless surfaces retain hierarchy and fit themes, large text and both devices', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.locator('.login-layout')).toBeVisible();
  await page.screenshot({ path: info.outputPath('borderless-login.png') });
  await useFixtureSession(page);
  await page.reload();
  const request = page.context().request;
  const appearance = await (await request.get('/api/preferences')).json();
  const user = (await (await request.get('/api/auth/me')).json()).user;
  const originalFont = await page.evaluate(
    (id) => localStorage.getItem(`drift:font-size:${id}`),
    user.id,
  );
  try {
    const mobileNavigation = page.getByRole('navigation', { name: '快捷导航' });
    if (info.project.name === 'mobile') {
      await expect(mobileNavigation).toBeVisible();
      const workspace = mobileNavigation.getByRole('button', { name: '工作区', exact: true });
      await workspace.click();
      await expect(page.locator('.sidebar')).toHaveClass(/\bopen\b/);
      await expect(page.getByRole('button', { name: '收起导航', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.sidebar')).not.toHaveClass(/\bopen\b/);
      await expect(workspace).toBeFocused();
      await mobileNavigation.getByRole('button', { name: '设置', exact: true }).click();
      await expect(page).toHaveURL(/#\/settings$/);
      await expect(
        mobileNavigation.getByRole('button', { name: '设置', exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await mobileNavigation.getByRole('button', { name: '对话', exact: true }).click();
      await expect(page).toHaveURL(/#\/chat$/);
    } else {
      await expect(mobileNavigation).toBeHidden();
    }
    for (const [theme, themeName, font, fontName] of [
      ['light', '白天', 'standard', '标准 100%'],
      ['dark', '黑夜', 'large', '较大 125%'],
    ] as const) {
      await page.goto('/#/settings/preferences');
      await page.getByRole('radio', { name: themeName, exact: true }).click();
      await page.getByRole('radio', { name: fontName, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('data-font-size', font);
      for (const route of routes) {
        await page.goto(route.path);
        await expect(page.locator(route.ready).first()).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        await expect
          .poll(() =>
            page
              .locator('.topbar')
              .evaluate((element) => Math.round(element.getBoundingClientRect().height)),
          )
          .toBe(info.project.name === 'mobile' ? 56 : 64);
        await expect(page.locator('.topbar')).toHaveCSS('border-width', '0px');
        expect(
          await page.locator('html').evaluate((element) => {
            const style = getComputedStyle(element);
            return [
              '--radius-hover',
              '--radius-control',
              '--radius-panel',
              '--radius-floating',
            ].map((token) => style.getPropertyValue(token).trim());
          }),
        ).toEqual(['8px', '12px', '16px', '24px']);
        if (route.name === 'chat-home' || route.name === 'chat-thread') {
          await expectBorderlessSurface(page.locator('.composer'));
          await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
          if (info.project.name === 'mobile') {
            await expect(mobileNavigation).toBeVisible();
            await expect
              .poll(async () => {
                const composer = await page.locator('.composer').boundingBox();
                const navigation = await mobileNavigation.boundingBox();
                return !!composer && !!navigation && composer.y + composer.height <= navigation.y;
              })
              .toBe(true);
          }
        }
        if (route.name === 'preferences') {
          await expectBorderlessSurface(page.locator('.font-settings'));
          await expect(page.locator('.font-settings')).toHaveCSS('border-radius', '16px');
        }
        if (route.name === 'usage') {
          await expectBorderlessSurface(page.locator('.stat-card').first());
          if (info.project.name === 'mobile') {
            await expect(page.locator('.usage-recent tbody')).toHaveCSS('display', 'block');
          }
        }
        await page.screenshot({
          path: info.outputPath(`borderless-${route.name}-${theme}-${font}.png`),
        });
      }
    }
    await page.goto('/#/chat');
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  } finally {
    await request.patch('/api/preferences', { data: appearance });
    await page.evaluate(
      ({ id, font }) => {
        if (font === null) localStorage.removeItem(`drift:font-size:${id}`);
        else localStorage.setItem(`drift:font-size:${id}`, font);
      },
      { id: user.id, font: originalFont },
    );
  }
});
