import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import { chooseModel } from './controls';
import { fontSizes } from '../../src/shared/typography';

test('Skill attachments remain available to text models, stream reference reads and retain pinned versions', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const request = page.context().request;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: `Skill ${info.project.name}`,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'test',
      },
    })
  ).json();
  const model = await (
    await request.post('/api/admin/models', {
      data: {
        providerId: provider.id,
        name: 'skill-tool',
        label: `Skill 工具模型 ${info.project.name}`,
        toolCalling: true,
      },
    })
  ).json();
  const skill = await (
    await request.post('/api/skills', {
      data: {
        title: `Skill 写作 ${info.project.name}`,
        content: '按需读取 references/style.md。',
        description: '写作润色',
        tags: ['写作'],
        files: [{ path: 'references/style.md', content: 'RESOURCE_ONLY_SECRET：使用短句。' }],
      },
    })
  ).json();
  await page.goto('/#/chat');
  await chooseModel(page, { id: model.id });
  await page.getByRole('button', { name: '添加内容和工具', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '添加内容和工具' });
  await expect(menu.getByRole('button', { name: '添加图片' })).toBeDisabled();
  await expect(menu.getByText('插件', { exact: true })).toBeVisible();
  await menu.getByRole('button', { name: 'Skill 库 插件' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('searchbox', { name: '搜索 Skill' }).fill(skill.title);
  await picker.getByRole('button', { name: `预览 ${skill.title}` }).click();
  await expect(picker.getByRole('region', { name: 'Skill 预览' })).toContainText(
    'references/style.md',
  );
  await expect(
    picker.locator('.skills-picker-item').getByRole('region', { name: 'Skill 预览' }),
  ).toBeVisible();
  await picker.getByRole('checkbox', { name: new RegExp(skill.title) }).check();
  await picker.getByRole('button', { name: '完成选择' }).click();
  await expect(page.getByRole('button', { name: '添加内容和工具', exact: true })).toBeFocused();
  const chips = page.getByLabel('已选 Skill');
  await expect(chips).toContainText(skill.title);
  const composer = page.getByRole('textbox', { name: '消息', exact: true });
  await expect(composer).toBeEmpty();
  await composer.fill('请润色这段文章');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const assistant = page.locator('.message.assistant').last();
  await expect(assistant).toContainText('已按 Skill 完成');
  await assistant.locator('.skills-details summary').click();
  await expect(assistant.locator('.skills-details')).toContainText('references/style.md');
  await expect(assistant).toContainText('130 tokens');
  await page.reload();
  await expect(chips).toContainText('v1');
  await request.patch(`/api/skills/${skill.id}`, {
    data: { version: 1, content: '新版主指令', files: [] },
  });
  await page.getByRole('button', { name: '添加内容和工具', exact: true }).click();
  await menu.getByRole('button', { name: 'Skill 库 插件' }).click();
  await picker.getByRole('searchbox', { name: '搜索 Skill' }).fill(skill.title);
  await picker.getByRole('button', { name: '更新到 v2' }).click();
  await picker.getByRole('button', { name: '完成选择' }).click();
  await expect(chips).toContainText('v2');
  await chips.getByRole('combobox').selectOption('turn');
  await composer.fill('仅本轮使用新版');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  await expect(chips).toHaveCount(0);
  await page.reload();
  await expect(chips).toHaveCount(0);
  expect(errors).toEqual([]);
  await request.delete(`/api/skills/${skill.id}`);
  await request.delete(`/api/admin/providers/${provider.id}`);
});

test('Skill menu and picker fit themes, four font sizes and mobile with Escape focus restoration', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const original = await (await request.get('/api/preferences')).json();
  const user = (await (await request.get('/api/auth/me')).json()).user;
  const skill = await (
    await request.post('/api/skills', {
      data: {
        title: `布局检查技能 ${info.project.name}`,
        content: '使用清晰的中文回答。',
        description: '这是一个用于验证大字号、手机触控与长名称换行的技能说明。',
        tags: ['布局'],
      },
    })
  ).json();
  for (const theme of ['light', 'dark']) {
    await request.patch('/api/preferences', { data: { ...original, theme } });
    for (const size of fontSizes) {
      await page.goto('/#/chat');
      await page.evaluate(({ id, size }) => localStorage.setItem(`drift:font-size:${id}`, size), {
        id: user.id,
        size: size.id,
      });
      await page.reload();
      const trigger = page.getByRole('button', { name: '添加内容和工具', exact: true });
      await trigger.click();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page
        .getByRole('dialog', { name: '添加内容和工具' })
        .getByRole('button', { name: 'Skill 库 插件' })
        .click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('searchbox', { name: '搜索 Skill' }).fill(skill.title);
      await expect(dialog.getByRole('checkbox')).toHaveCount(1);
      const bounds = (await dialog.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (size.id === 'large')
        await page.screenshot({
          path: `test-results/skill-picker-${theme}-${info.project.name}.png`,
        });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
    }
  }
  await request.delete(`/api/skills/${skill.id}`);
  await request.patch('/api/preferences', { data: original });
});

test('long Skill lists keep selection and preview usable while scrolling', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.context().request;
  const created: string[] = [];
  const listTag = `长列表-${info.project.name}`;
  try {
    for (let index = 0; index < 12; index++) {
      const skill = await (
        await request.post('/api/skills', {
          data: {
            title: `长列表技能 ${String(index).padStart(2, '0')} ${info.project.name}`,
            content: `第 ${index} 项技能的主指令`,
            description: '用于检查长列表在窄屏中的选择、预览与固定完成操作。',
            tags: [listTag],
          },
        })
      ).json();
      created.push(skill.id);
    }
    await page.goto('/#/chat');
    await page.getByRole('button', { name: '添加内容和工具', exact: true }).click();
    await page
      .getByRole('dialog', { name: '添加内容和工具' })
      .getByRole('button', { name: 'Skill 库 插件' })
      .click();
    const picker = page.getByRole('dialog', { name: 'Skill 库' });
    await picker.getByRole('combobox', { name: '标签' }).selectOption(listTag);
    const list = picker.locator('.skills-picker-list');
    await expect(list.locator('.skills-picker-item')).toHaveCount(12);
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    const last = list.locator('.skills-picker-item').last();
    await last.getByRole('checkbox').check();
    await expect(picker.locator('.skills-picker-footer')).toContainText('已选 1 / 8');
    await last.getByRole('button', { name: /预览 长列表技能 00/ }).click();
    await expect(last.getByRole('region', { name: 'Skill 预览' })).toContainText('第 0 项技能');
    await expect(picker.getByRole('button', { name: '完成选择' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await picker.getByRole('button', { name: '完成选择' }).click();
    await expect(page.getByLabel('已选 Skill')).toContainText('长列表技能 00');
  } finally {
    for (const id of created) await request.delete(`/api/skills/${id}`);
  }
});
