import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';

test('required artifact mode shows real delivery, partial failure, clarification and preserves edit/retry policy', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const saved = await (await request.get('/api/llm-production/preferences')).json();
  const appearance = await (await request.get('/api/preferences')).json();
  const source = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `交付测试 ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
      },
    })
  ).json();
  const models = new Map<string, string>();
  const conversations: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    for (const name of ['delivery-mixed', 'delivery-partial', 'delivery-clarify', 'basic']) {
      const model = await (
        await request.post('/api/admin/models', {
          data: {
            providerId: source.id,
            name,
            label: `${name} ${info.project.name}`,
            toolCalling: name !== 'basic',
          },
        })
      ).json();
      models.set(name, model.id);
    }
    const image = await (
      await request.post('/api/admin/models', {
        data: {
          providerId: source.id,
          name: 'production-image',
          label: `交付图片 ${info.project.name}`,
          kind: 'image',
        },
      })
    ).json();
    expect(
      (
        await request.patch('/api/llm-production/preferences', {
          data: { enabled: true, imageModelId: image.id },
        })
      ).ok(),
    ).toBe(true);
    const openConversation = async () => {
      const conversation = await (await request.post('/api/conversations', { data: {} })).json();
      conversations.push(conversation.id);
      await page.goto(`/#/chat/${conversation.id}`);
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
      return conversation.id;
    };
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    const mode = page.getByLabel('产物输出', { exact: true });
    const submit = page.getByRole('button', { name: '发送消息', exact: true });
    const completedId = await openConversation();
    await chooseModel(page, { id: models.get('delivery-mixed')! });
    await expect(mode).toHaveValue('auto');
    await mode.selectOption('required');
    await input.fill('完成约定的网页、表格和两张图片');
    await submit.click();
    const answer = page.locator('.message.assistant').last();
    await expect(answer).toContainText('完成 4/4');
    await expect(answer.getByRole('link', { name: /^下载 / })).toHaveCount(4);
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    const downloadPromise = page.waitForEvent('download');
    await answer.getByRole('link', { name: /^下载 计算器\.html/ }).click();
    expect((await downloadPromise).suggestedFilename()).toBe('计算器.html');
    await page.reload();
    await expect(answer).toContainText('完成 4/4');
    await expect(mode).toHaveValue('auto');
    await input.fill('待发送的草稿');
    await page.getByRole('button', { name: '编辑提问', exact: true }).click();
    await expect(mode).toHaveValue('required');
    await page.getByRole('button', { name: '取消编辑提问', exact: true }).click();
    await expect(input).toHaveText('待发送的草稿');
    await expect(mode).toHaveValue('auto');
    for (const theme of ['light', 'dark']) {
      await request.patch('/api/preferences', { data: { ...appearance, theme } });
      await page.reload();
      await page.evaluate(() => document.documentElement.style.setProperty('--font-scale', '1.15'));
      await answer.locator('summary').click();
      await expect(answer.getByRole('region', { name: '产物交付清单', exact: true })).toBeVisible();
      await expect(answer.getByText('已生成', { exact: true })).toHaveCount(4);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      expect(
        await answer
          .locator('.llm-production-delivery')
          .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await page.screenshot({ path: info.outputPath(`delivery-${theme}.png`) });
    }
    const partialId = await openConversation();
    await chooseModel(page, { id: models.get('delivery-partial')! });
    await mode.selectOption('required');
    await input.fill('继续完成约定');
    await submit.click();
    await expect(answer).toContainText('完成 1/4 · 未完成');
    await expect(answer.getByRole('link', { name: /^下载 / })).toHaveCount(1);
    await expect(answer).toContainText('未完成产物交付');
    await mode.selectOption('auto');
    await chooseModel(page, { id: models.get('basic')! });
    await expect(mode.locator('option[value="required"]')).toBeDisabled();
    await page.getByRole('button', { name: '重新输出', exact: true }).click();
    await expect(
      page.getByText('此提问要求交付产物，请选择已启用工具调用的模型后发送或重试。', {
        exact: true,
      }),
    ).toBeVisible();
    await chooseModel(page, { id: models.get('delivery-mixed')! });
    await page.getByRole('button', { name: '重新输出', exact: true }).click();
    await expect(answer).toContainText('完成 4/4');
    const messages = (await (await request.get(`/api/conversations/${partialId}`)).json()).messages;
    expect(messages[0].productionMode).toBe('required');
    expect(messages.at(-1).productionMode).toBe('required');
    await openConversation();
    await chooseModel(page, { id: models.get('delivery-clarify')! });
    await mode.selectOption('required');
    await input.fill('按约定做出来');
    await submit.click();
    await expect(answer.getByRole('status', { name: '' })).toContainText('产物需求待补充');
    await expect(answer).toContainText('需要交付哪些文件，内容和格式是什么？');
    await expect(answer.getByRole('link', { name: /^下载 / })).toHaveCount(0);
    await page.goto(`/#/chat/${completedId}`);
    await expect(answer).toContainText('完成 4/4');
    expect(errors).toEqual([]);
  } finally {
    await request.patch('/api/llm-production/preferences', { data: saved });
    await request.patch('/api/preferences', { data: appearance });
    for (const id of conversations) await request.delete(`/api/conversations/${id}`);
    await request.delete(`/api/admin/providers/${source.id}`);
  }
});
