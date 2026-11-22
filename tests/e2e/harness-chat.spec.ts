import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { useFixtureSession } from '../e2e-session';
import type { HarnessRun, Message, StreamEvent } from '../../src/shared/types';

test('clarification saves a tentative suggestion and waits for an editable user reply', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.request;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: '澄清 ' + info.project.name,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
        apiMode: 'responses',
      },
    })
  ).json();
  try {
    const model = await (
      await request.post('/api/admin/models', {
        data: {
          providerId: provider.id,
          name: 'harness-clarification',
          label: '澄清测试',
          toolCalling: true,
        },
      })
    ).json();
    const chat = await (await request.post('/api/conversations', { data: {} })).json();
    const prefix = '/api/conversations/' + chat.id;
    await page.addInitScript((modelId) => localStorage.setItem('kh:model', modelId), model.id);
    await page.goto('/#/chat/' + chat.id);
    const editor = page.getByRole('textbox', { name: '消息', exact: true });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await editor.fill('请先确定受众');
    await send.click();
    const question = '这份报告主要给谁看？';
    const suggestion = '先为项目负责人写一页摘要，方便确定范围。';
    const latestCard = page.getByRole('region', { name: '待确认问题' }).last();
    await expect(latestCard).toContainText(suggestion);
    await expect
      .poll(
        async () => (await (await request.get(prefix)).json()).messages.at(-1)?.harnessRun?.phase,
      )
      .toBe('waiting');
    const snapshot = async (): Promise<Message[]> =>
      (await (await request.get(prefix)).json()).messages;
    const first = (await snapshot()).at(-1)!;
    expect(first.harnessRun?.clarification).toEqual({ question, suggestion });
    expect(first.content).toContain(suggestion);
    await page.reload();
    await expect(page.getByText(question, { exact: true })).toHaveCount(1);
    await latestCard.getByRole('button', { name: '自行回复' }).click();
    await expect(editor).toBeFocused();
    await editor.fill('先确认时长。');
    await latestCard.getByRole('button', { name: '用建议起草回复' }).click();
    await expect(editor).toContainText('先确认时长。');
    await expect(editor).toContainText(suggestion);
    expect(await snapshot()).toHaveLength(2);
    await editor.press('ControlOrMeta+a');
    await page.keyboard.insertText('改为面向设计团队');
    await expect(editor).toHaveText('改为面向设计团队');
    await send.click();
    await expect(page.getByText('已按确认的受众继续。', { exact: true })).toBeVisible();
    expect((await snapshot()).filter((m) => m.role === 'user').at(-1)?.content).toBe(
      '改为面向设计团队',
    );
    await expect(latestCard.getByRole('button')).toHaveCount(0);
    await editor.fill('旧格式只提问');
    await send.click();
    await expect(latestCard.getByRole('button', { name: '自行回复' })).toBeVisible();
    await expect(latestCard.getByText('初步建议')).toHaveCount(0);
    await expect(latestCard.getByRole('button', { name: '用建议起草回复' })).toHaveCount(0);
    expect((await snapshot()).at(-1)?.harnessRun?.clarification).toEqual({ question });
  } finally {
    await request.delete('/api/admin/providers/' + provider.id);
  }
});

test('workspace publishes reviewed handoff and file versions, and personal preferences require admission', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.request;
  const group = await (
    await request.post('/api/conversation-groups', {
      data: { name: '工作区 ' + info.project.name },
    })
  ).json();
  const chat = await (
    await request.post('/api/conversations', { data: { groupId: group.id } })
  ).json();
  const other = await (
    await request.post('/api/conversations', { data: { groupId: group.id } })
  ).json();
  const sourcePath = '/api/conversations/' + chat.id + '/workspace';
  const ref = await (
    await request.post(sourcePath + '/documents', {
      data: { name: '参考.md', content: '相互独立的参考文件' },
    })
  ).json();
  await page.goto('/#/chat/' + chat.id);
  await page.getByRole('button', { name: '对话工作区', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '对话工作区' });
  await dialog.getByRole('button', { name: '新建文档' }).click();
  await dialog.getByRole('combobox', { name: '类型', exact: true }).selectOption('handoff');
  await dialog.getByLabel('文件名', { exact: true }).fill('项目交接.md');
  await dialog.getByLabel('正文', { exact: true }).fill('第一版的交接结论');
  await dialog.getByRole('button', { name: '保存到本会话' }).click();
  await expect(dialog.getByRole('heading', { name: '项目交接.md' })).toBeVisible();
  await dialog.getByRole('button', { name: '编辑正文' }).click();
  await dialog.getByRole('textbox', { name: '编辑正文', exact: true }).fill('用户复核过的第二版');
  await dialog.getByRole('button', { name: '预览项目发布' }).click();
  await expect(dialog.getByText('用户复核过的第二版', { exact: true })).toBeVisible();
  await dialog.locator('summary').filter({ hasText: '一并发布的文件版本' }).click();
  await dialog.getByRole('checkbox', { name: '参考.md' }).check();
  await dialog.getByRole('button', { name: '确认发布到项目' }).click();
  await expect(dialog.getByRole('combobox', { name: '查看版本', exact: true })).toHaveValue('2');
  await dialog.getByRole('combobox', { name: '查看版本', exact: true }).selectOption('1');
  await expect(dialog.getByText('第一版的交接结论', { exact: true })).toBeVisible();
  const destination = await (
    await request.get('/api/conversations/' + other.id + '/workspace')
  ).json();
  expect(destination.documents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: '项目交接.md', scope: 'project', version: 2 }),
      expect.objectContaining({ id: ref.id, scope: 'project', version: 1 }),
    ]),
  );
  await dialog.getByRole('button', { name: '个人偏好', exact: true }).click();
  const preference = '用表格比较版本 ' + info.project.name;
  await dialog.getByRole('textbox', { name: '新增个人偏好', exact: true }).fill(preference);
  await dialog.getByRole('button', { name: '保存为待纳入' }).click();
  const item = dialog.locator('article').filter({ hasText: preference });
  await expect(item).toContainText('待纳入');
  await item.getByRole('button', { name: '纳入个人偏好' }).click();
  await expect(item).toContainText('已纳入');
  await item.getByRole('button', { name: '撤出偏好' }).click();
  await expect(item).toContainText('已撤出');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('button', { name: '对话工作区', exact: true })).toBeFocused();
});

test('one real progress row restores steering receipt and application from snapshots; legacy transcript is read-only', async ({
  page,
}) => {
  await useFixtureSession(page);
  const chat = await (await page.request.post('/api/conversations', { data: {} })).json();
  const messageId = randomUUID();
  const run: HarnessRun = {
    phase: 'search',
    detail: '正在搜索项目资料',
    steps: [{ label: '检索资料', status: 'running' }],
    steering: [],
  };
  const answer: Message = {
    id: messageId,
    role: 'assistant',
    status: 'streaming',
    images: [],
    content: '',
    createdAt: new Date().toISOString(),
    harnessRun: run,
  };
  let harness = true;
  let steerPosts = 0;
  await page.route('**/api/conversations/' + chat.id + '/events', (route) => {
    const snapshot: StreamEvent = { type: 'snapshot', harness, messages: [answer] };
    return route.fulfill({
      contentType: 'text/event-stream',
      body: 'data: ' + JSON.stringify(snapshot) + '\n\n',
    });
  });
  await page.route('**/api/conversations/' + chat.id + '/steer', (route) => {
    const { messageId: targetId, content, requestId } = route.request().postDataJSON();
    expect(targetId).toBe(messageId);
    steerPosts++;
    run.steering.push({ id: requestId, content, applied: false });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/chat/' + chat.id);
  const details = page.locator('details.harness-progress');
  await expect(details.locator('summary')).toContainText('正在搜索项目资料');
  await expect(details.getByText('检索资料', { exact: false })).not.toBeVisible();
  const editor = page.getByRole('textbox', { name: '消息', exact: true });
  await editor.fill('补充查询签订日期');
  await page.getByRole('button', { name: '发送补充' }).click();
  await expect(details.locator('summary')).toContainText('补充已收到');
  expect(steerPosts).toBe(1);
  run.steering[0].applied = true;
  await page.reload();
  await expect(details.locator('summary')).toContainText('补充已应用');
  await details.locator('summary').click();
  await expect(details.getByText('补充查询签订日期', { exact: false })).toBeVisible();
  harness = false;
  answer.status = 'complete';
  answer.content = '旧对话已保存';
  delete answer.harnessRun;
  await page.reload();
  await expect(page.getByText('旧对话已保存', { exact: true })).toBeVisible();
  await expect(page.getByText('历史对话 · 只读')).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole('button', { name: '再次生成' })).toHaveCount(0);
});

test('project artifact cards count only published files and keep the original conversation space private', async ({
  page,
}) => {
  await useFixtureSession(page);
  const groupId = randomUUID(),
    otherGroup = randomUUID(),
    chatId = randomUUID();
  const groups = [
    { id: groupId, name: '原项目', icon: 'folder', colorSlot: null },
    { id: otherGroup, name: '另一个共享项目', icon: 'folder', colorSlot: null },
  ];
  const chat = {
    id: chatId,
    title: '来源对话',
    updatedAt: new Date().toISOString(),
    harness: true,
    generating: false,
    colorSlot: null,
    groupId,
  };
  const file = {
    id: randomUUID(),
    name: '会话私稿.txt',
    mimeType: 'text/plain',
    size: 24,
    createdAt: chat.updatedAt,
    expiresAt: null,
    conversationId: chatId,
    messageId: null,
    groupId: null,
    spaceName: chat.title,
  };
  const published = {
    ...file,
    id: randomUUID(),
    name: '交接定稿.txt',
    publishedGroupIds: [groupId, otherGroup],
  };
  await page.route('**/api/conversations', (route) => route.fulfill({ json: [chat] }));
  await page.route('**/api/conversation-groups', (route) => route.fulfill({ json: groups }));
  await page.route('**/api/llm-production/artifacts*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: { artifacts: params.has('groupId') ? [published] : [file, published], space: null },
    });
  });
  await page.goto('/#/llm-production');
  await expect(page.locator('.page-heading')).toContainText('2 个产物');
  const card = page.getByRole('button', { name: '管理对话产物 来源对话' });
  await expect(card).toContainText('2 个产物');
  await page.getByRole('button', { name: '筛选分组 另一个共享项目' }).click();
  await expect(card).toContainText('1 个产物');
  const scopedRequest = page.waitForRequest(
    (req) => new URL(req.url()).searchParams.get('groupId') === otherGroup,
  );
  await card.click();
  await scopedRequest;
  await expect(page.getByRole('heading', { name: '交接定稿.txt' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '会话私稿.txt' })).toHaveCount(0);
  await page.getByRole('button', { name: '返回产物空间' }).click();
  await page.getByRole('button', { name: '筛选分组 全部空间' }).click();
  const privateRequest = page.waitForRequest(
    (req) => new URL(req.url()).searchParams.get('conversationId') === chatId,
  );
  await card.click();
  await privateRequest;
  await expect(page.getByRole('heading', { name: '会话私稿.txt' })).toBeVisible();
});

test('a source chat can approve a private revision and the target continues its original task once', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const request = page.request;
  const provider = await (
    await request.post('/api/admin/providers', {
      data: {
        name: '授权流程 ' + info.project.name,
        baseUrl: 'http://127.0.0.1:3211/v1',
        apiKey: 'fixture',
        apiMode: 'responses',
      },
    })
  ).json();
  try {
    const model = await (
      await request.post('/api/admin/models', {
        data: { providerId: provider.id, name: 'test-text', label: '授权流程模型' },
      })
    ).json();
    const project = await (
      await request.post('/api/conversation-groups', {
        data: { name: '授权 ' + info.project.name },
      })
    ).json();
    const source = await (
      await request.post('/api/conversations', { data: { groupId: project.id } })
    ).json();
    const target = await (
      await request.post('/api/conversations', { data: { groupId: project.id } })
    ).json();
    const sourcePrefix = '/api/conversations/' + source.id + '/workspace';
    const targetPrefix = '/api/conversations/' + target.id;
    const file = await (
      await request.post(sourcePrefix + '/documents', {
        data: { name: '私有证据.md', content: '经用户核实的来源证据' },
      })
    ).json();
    const task = await (
      await request.post(targetPrefix + '/messages', {
        data: { modelId: model.id, content: '拟定验收标准' },
      })
    ).json();
    await expect
      .poll(async () => (await (await request.get(targetPrefix)).json()).messages.at(-1)?.status)
      .toBe('complete');
    const pending = await (
      await request.post(targetPrefix + '/workspace/requests', {
        data: {
          sourceConversationId: source.id,
          taskId: task.messageId,
          purpose: '本次验收引用证据',
        },
      })
    ).json();
    await page.goto('/#/chat/' + source.id);
    await page.getByRole('button', { name: '待处理文件请求（1）' }).click();
    const dialog = page.getByRole('dialog', { name: '对话工作区' });
    const card = dialog.locator('article').filter({ hasText: '本次验收引用证据' });
    await card.getByRole('combobox', { name: '授权文件' }).selectOption(file.id);
    await expect(card.getByText('经用户核实的来源证据', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: '批准此版本' }).click();
    await card.getByRole('button', { name: '返回目标对话' }).click();
    await expect(page).toHaveURL(new RegExp(target.id + '$'));
    await expect
      .poll(async () => {
        const saved = await (await request.get(targetPrefix)).json();
        return saved.messages.find((m: Message) => m.id === pending.id)?.status;
      })
      .toBe('complete');
    await page.getByRole('button', { name: '对话工作区', exact: true }).click();
    await dialog.getByRole('button', { name: '访问授权', exact: true }).click();
    await dialog.getByRole('button', { name: '继续原任务', exact: true }).click();
    await expect(
      dialog.getByText('已确认继续请求，可在对话中查看进度。', { exact: true }),
    ).toBeVisible();
    const result = await (await request.get(targetPrefix)).json();
    expect(result.messages.filter((m: Message) => m.role === 'assistant')).toHaveLength(2);
    await dialog.getByRole('button', { name: '文档', exact: true }).click();
    await dialog.getByRole('button', { name: '私有证据.md 指定版本授权 · v1' }).click();
    await expect(dialog.getByText('经用户核实的来源证据', { exact: true })).toBeVisible();
  } finally {
    await request.delete('/api/admin/providers/' + provider.id);
  }
});

test('direct share opens only the selected existing revision in the target without a task', async ({
  page,
}, info) => {
  await useFixtureSession(page);
  const api = page.request;
  const group = await (
    await api.post('/api/conversation-groups', { data: { name: '定向分享 ' + info.project.name } })
  ).json();
  const createChat = async () =>
    (await (await api.post('/api/conversations', { data: { groupId: group.id } })).json())
      .id as string;
  const a = await createChat(),
    b = await createChat(),
    c = await createChat();
  const sourcePath = '/api/conversations/' + a + '/workspace';
  const doc = await (
    await api.post(sourcePath + '/documents', {
      data: { name: '定向资料.md', content: '已审阅的第一版' },
    })
  ).json();
  await api.patch(sourcePath + '/documents/' + doc.id, {
    data: { baseVersion: 1, content: '未开放的第二版' },
  });
  await page.goto('/#/chat/' + a);
  await page.getByRole('button', { name: '对话工作区', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '对话工作区' });
  await modal.getByRole('button', { name: '访问授权', exact: true }).click();
  await modal.getByRole('combobox', { name: '操作', exact: true }).selectOption('share');
  await modal.getByRole('combobox', { name: '目标对话', exact: true }).selectOption(b);
  await modal.getByRole('combobox', { name: '授权文件', exact: true }).selectOption(doc.id);
  await modal.getByRole('combobox', { name: '授权版本', exact: true }).selectOption('1');
  await expect(modal.getByText('已审阅的第一版', { exact: true })).toBeVisible();
  await modal.getByRole('button', { name: '分享此版本', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('已分享');
  expect((await (await api.get('/api/conversations/' + b)).json()).messages).toHaveLength(0);
  expect(
    (await api.get('/api/conversations/' + c + '/workspace/documents/' + doc.id)).status(),
  ).toBe(404);
  await modal.getByRole('button', { name: '关闭', exact: true }).click();
  await page.goto('/#/chat/' + b);
  await page.getByRole('button', { name: '对话工作区', exact: true }).click();
  await modal.getByRole('button', { name: /定向资料\.md/ }).click();
  await expect(modal.getByText('已审阅的第一版', { exact: true })).toBeVisible();
  await expect(
    modal.getByRole('combobox', { name: '查看版本', exact: true }).locator('option'),
  ).toHaveCount(1);
});
