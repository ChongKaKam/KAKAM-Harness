import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { useFixtureSession } from '../e2e-session';
import { chooseEffort, chooseModel } from './controls';

test('Max persists, reports unsupported models and retries at a lower effort', async ({
  page,
}, info) => {
  const requests: Record<string, any>[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'max-supported' }, { id: 'max-unsupported' }] }));
      return;
    }
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    if (body.model === 'max-unsupported' && body.reasoning_effort === 'max') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            param: 'reasoning_effort',
            message: "Unsupported value: 'max' for reasoning_effort",
          },
        }),
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Max test reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  expect(address && typeof address !== 'string').toBeTruthy();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to listen');
  let providerId: string | undefined;
  try {
    await useFixtureSession(page);
    const provider = await (
      await page.request.post('/api/admin/providers', {
        data: {
          name: `Max ${info.project.name}`,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: '',
          apiMode: 'chat-completions',
        },
      })
    ).json();
    providerId = provider.id;
    const models = [];
    for (const name of ['max-unsupported', 'max-supported'])
      models.push(
        await (
          await page.request.post('/api/admin/models', {
            data: { providerId, name, label: `${name} ${info.project.name}` },
          })
        ).json(),
      );
    await page.goto('/#/chat');
    await chooseModel(page, { id: models[0].id });
    await chooseEffort(page, 'Max');
    await page.reload();
    const trigger = page.getByRole('button', { name: /^模型与思考程度：/ });
    await expect(trigger).toContainText('最大');
    await trigger.click();
    const slider = page.getByRole('slider', { name: '思考程度', exact: true });
    await slider.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Max · 最大');
    await expect(slider).toHaveAttribute('max', '5');
    await expect(slider).toHaveCSS('--effort-progress', '100%');
    for (const theme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect
        .poll(() =>
          page
            .getByRole('dialog', { name: '模型与思考设置' })
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        )
        .toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('测试 Max 不支持后的重试');
    await page.getByRole('button', { name: '发送消息' }).click();
    const assistant = page.locator('.message.assistant');
    await expect(assistant).toContainText('当前模型不支持 Max 思考强度，请切换其他思考程度后重试');
    expect(requests).toHaveLength(1);
    expect(requests[0].reasoning_effort).toBe('max');
    await page.reload();
    await expect(assistant).toContainText('当前模型不支持 Max 思考强度');
    await chooseEffort(page, 'High');
    await page.getByRole('button', { name: '重新输出', exact: true }).click();
    await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();
    await expect(assistant).toContainText('Max test reply');
    await expect(page.locator('.message.user')).toHaveCount(1);
    expect(requests).toHaveLength(2);
    expect(requests[1].reasoning_effort).toBe('high');

    await page.getByRole('button', { name: '再次生成', exact: true }).click();
    const regenerate = page.getByRole('dialog', { name: '再次生成回复', exact: true });
    await regenerate.getByRole('button', { name: /^模型与思考程度：/ }).click();
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    await page
      .getByRole('radiogroup', { name: '可用模型' })
      .locator(`[data-model-id="${models[1].id}"]`)
      .click();
    await page.getByRole('button', { name: '思考程度 Max', exact: true }).click();
    await page.getByRole('button', { name: '关闭模型设置' }).click();
    await regenerate.getByRole('button', { name: '开始生成', exact: true }).click();
    await expect(page.getByRole('button', { name: '复制回复' })).toBeVisible();
    expect(requests).toHaveLength(3);
    expect(requests[2].model).toBe('max-supported');
    expect(requests[2].reasoning_effort).toBe('max');
    await expect(page.locator('.message.user')).toHaveCount(1);
    await expect(assistant).toHaveCount(1);

    const diagnostic = await page.request.post(`/api/admin/models/${models[0].id}/test`, {
      data: { reasoningEffort: 'max' },
    });
    expect(diagnostic.ok()).toBe(true);
    const result = await diagnostic.json();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('当前模型不支持 Max 思考强度');
    expect(JSON.parse(result.diagnostics.request.body).reasoning_effort).toBe('max');
  } finally {
    if (providerId) await page.request.delete(`/api/admin/providers/${providerId}`, { data: {} });
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
