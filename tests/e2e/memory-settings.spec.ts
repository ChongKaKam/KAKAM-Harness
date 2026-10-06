import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { defaultConfig, defaultPreferences } from '../../src/features/memory/config';
import { defaultStrategy } from '../../src/features/memory/strategies/default';

test('memory switch persists immediately and displays the effective state', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const embeddingId = randomUUID(),
    llmId = randomUUID();
  let preferences = {
    ...defaultPreferences,
    embeddingModelId: embeddingId,
    recallModelId: llmId,
    extractModelId: llmId,
  };
  let rejected = false;
  await page.route('**/api/models?kind=all', (route) =>
    route.fulfill({
      json: [
        {
          id: embeddingId,
          label: 'Fixture embedding',
          providerName: 'Local mock',
          kind: 'embedding',
          enabled: true,
          validatedDimensions: 3,
        },
        { id: llmId, label: 'Fixture LLM', providerName: 'Local mock', kind: 'llm', enabled: true },
      ],
    }),
  );
  await page.route('**/api/memory/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/status'))
      return route.fulfill({ json: { configured: true, ready: true, error: null, spaces: [] } });
    if (path.endsWith('/preferences')) {
      if (route.request().method() === 'PATCH' && rejected)
        return route.fulfill({ status: 403, json: { error: '原模型未授权，请重新选择' } });
      if (route.request().method() === 'PATCH')
        preferences = { ...preferences, ...route.request().postDataJSON() };
      return route.fulfill({ json: preferences });
    }
    if (path.endsWith('/strategies')) return route.fulfill({ json: [defaultStrategy.info] });
    if (path.endsWith('/config'))
      return route.fulfill({ json: { version: 0, config: defaultConfig } });
    return route.abort();
  });
  await page.goto('/#/settings/memory');
  const toggle = page.getByRole('checkbox', { name: '启用对话召回与抽取', exact: true });
  await toggle.check();
  await expect.poll(() => preferences.enabled, { timeout: 3000 }).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: '对话记忆已启用' })).toBeVisible();
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect.poll(() => preferences.enabled).toBe(false);
  await expect(page.getByRole('status').filter({ hasText: '对话记忆已关闭' })).toBeVisible();
  rejected = true;
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('原模型未授权');
  await expect(toggle).not.toBeChecked();
  expect(preferences.enabled).toBe(false);
  rejected = false;
  await page.getByRole('combobox', { name: 'Embedding 模型', exact: true }).selectOption('');
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('启用前请选择');
  await expect(toggle).not.toBeChecked();
  expect(preferences.enabled).toBe(false);
  await page
    .getByRole('combobox', { name: 'Embedding 模型', exact: true })
    .selectOption(embeddingId);
  await toggle.click();
  await expect(page.getByRole('status').filter({ hasText: '对话记忆已启用' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/memory-settings-compact-${info.project.name}.png` });
  const request = page.context().request;
  const ui = await (await request.get('/api/preferences')).json();
  const { user } = await (await request.get('/api/auth/me')).json();
  const font = await page.evaluate(
    (userId) => localStorage.getItem(`drift:font-size:${userId}`),
    user.id,
  );
  try {
    await request.patch('/api/preferences', { data: { ...ui, theme: 'dark' } });
    await page.evaluate(
      (userId) => localStorage.setItem(`drift:font-size:${userId}`, 'large'),
      user.id,
    );
    await page.reload();
    await expect(toggle).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `test-results/memory-settings-dark-large-${info.project.name}.png`,
    });
  } finally {
    await request.patch('/api/preferences', { data: ui });
    await page.evaluate(
      ({ userId, font }) => {
        if (font === null) localStorage.removeItem(`drift:font-size:${userId}`);
        else localStorage.setItem(`drift:font-size:${userId}`, font);
      },
      { userId: user.id, font },
    );
  }
});
