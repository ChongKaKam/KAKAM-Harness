import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';
import { fontSizes } from '../../src/shared/typography';
import { syntaxConversation } from '../syntax-fixture';

test('reply timing persists and usage status stays readable across themes, sizes and mobile', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const prefix = `Timing ${info.project.name}`;
  const provider = await (
    await page.request.post('/api/admin/providers', {
      data: {
        name: prefix,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
        apiMode: 'responses',
      },
    })
  ).json();
  const conversations: string[] = [];
  const modelIds: Record<string, string> = {};
  try {
    for (const name of ['test-vision', 'upstream-error', 'slow']) {
      const model = await (
        await page.request.post('/api/admin/models', {
          data: {
            providerId: provider.id,
            name,
            label: `${prefix} ${name}`,
          },
        })
      ).json();
      modelIds[name] = model.id;
    }
    await page.goto(`/#/chat/${syntaxConversation}`);
    await expect(page.locator('.message.assistant')).toHaveCount(1);
    await expect(page.locator('.chat-generation-time')).toHaveCount(0);
    await page.goto('/#/chat');
    await chooseModel(page, { id: modelIds['test-vision'] });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('计时测试');
    await page.getByRole('button', { name: '发送消息' }).click();
    const timing = page.locator('.chat-generation-time');
    await expect(timing).toContainText(/用时 (?:< 0\.1|\d+\.\d) 秒/);
    if (info.project.name === 'desktop') {
      const timeBox = (await timing.boundingBox())!;
      const copyBox = (await page
        .getByRole('button', { name: '复制回复', exact: true })
        .boundingBox())!;
      expect(
        Math.abs(timeBox.y + timeBox.height / 2 - copyBox.y - copyBox.height / 2),
      ).toBeLessThan(1);
    }
    const text = await timing.textContent();
    const id = page.url().split('/chat/')[1];
    conversations.push(id);
    const saved = (await (await page.request.get(`/api/conversations/${id}`)).json()).messages[1];
    expect(saved.durationMs).toBeGreaterThan(0);
    await page.reload();
    await expect(timing).toHaveText(text!);
    await expect(
      page.locator('.chat-message-actions').getByRole('button', { name: '复制回复' }),
    ).toBeVisible();
    for (const [name, expected] of [
      ['upstream-error', 'error'],
      ['slow', 'cancelled'],
    ]) {
      const chat = await (await page.request.post('/api/conversations', { data: {} })).json();
      conversations.push(chat.id);
      await page.request.post(`/api/conversations/${chat.id}/messages`, {
        data: { modelId: modelIds[name], content: 'status fixture' },
      });
      if (expected === 'cancelled') {
        const stopped = await page.request.post(`/api/conversations/${chat.id}/stop`, {
          data: {},
        });
        expect(stopped.ok()).toBe(true);
      }
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/conversations/${chat.id}`)).json()).messages[1]
              .status,
        )
        .toBe(expected);
      await page.goto(`/#/chat/${chat.id}`);
      await expect(timing).toContainText('已用时');
    }
    for (const theme of ['light', 'dark']) {
      await page.request.patch('/api/preferences', { data: { theme, assistantIcon: null } });
      await page.goto('/#/usage');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const table = page.getByRole('table', { name: '最近调用' });
      const success = table.getByRole('row').filter({ hasText: `${prefix} test-vision` });
      const failure = table.getByRole('row').filter({ hasText: `${prefix} upstream-error` });
      const cancelled = table.getByRole('row').filter({ hasText: `${prefix} slow` });
      await expect(success.locator('.usage-status')).toHaveText('完成');
      await expect(failure.locator('.usage-status')).toHaveText('失败');
      await expect(cancelled.locator('.usage-status')).toHaveText('已停止');
      for (const [row, channel] of [
        [success, 1],
        [failure, 0],
      ] as const) {
        const styles = await row.locator('.usage-status').evaluate((el) => {
          const style = getComputedStyle(el);
          return { color: style.color, background: style.backgroundColor };
        });
        const rgb = (value: string) => value.match(/\d+/g)!.slice(0, 3).map(Number);
        const color = rgb(styles.color);
        expect(color[channel]).toBeGreaterThan(color[1 - channel]);
        const luminance = (values: number[]) =>
          values
            .map((n) => n / 255)
            .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
            .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
        const ink = luminance(color),
          fill = luminance(rgb(styles.background));
        expect((Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05)).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      for (const size of fontSizes) {
        await page.evaluate(
          (scale) => document.documentElement.style.setProperty('--font-scale', String(scale)),
          size.scale,
        );
        expect(
          parseFloat(
            await success
              .getByRole('cell')
              .first()
              .evaluate((el) => getComputedStyle(el).fontSize),
          ),
        ).toBeCloseTo(14 * size.scale, 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
      await page.locator('.usage-recent').scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/usage-status-${theme}-${info.project.name}.png`,
      });
      await page.goto(`/#/chat/${id}`);
      await expect(timing).toHaveText(text!);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `test-results/reply-timing-${theme}-${info.project.name}.png`,
      });
    }
  } finally {
    for (const id of conversations)
      await page.request.delete(`/api/conversations/${id}`, { data: {} });
    await page.request.delete(`/api/admin/providers/${provider.id}`, { data: {} });
    await page.request.patch('/api/preferences', {
      data: { theme: 'system', assistantIcon: null },
    });
  }
});
