import { executeHarness } from '../harness/execute';
import { skillSelections } from '../extensions/skill-runtime';
import type { ContextRecorder } from '../extensions/context-observer';
import { HarnessExecution } from '../harness/run';
import {
  applyWorkspaceCommand,
  initializeWorkspace,
  isHarnessConversation,
} from '../harness/workspace';
import type { WorkspaceApproval } from '../harness/types';
import { registerWorkspaceRoutes } from '../harness/routes';
import { registerHarnessTools } from '../harness/tools';
import type { SelectedSkill } from '../skills/types';
import { aggregateCalls, prepareConversationTools } from './skill-generation';
import { DEFAULT_MAX_CONCURRENT_CHATS } from './limits';
import type { ExtensionCall, HarnessRun, User } from '../../shared/types';
import { modesSchema } from '../extensions/server';
import { Router, type Response } from 'express';
import type { Context } from 'cordis';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
import { ownGroup, registerGroupRoutes } from './groups-server';
import type { Message, StreamEvent, Attachment } from '../../shared/types';
export { manifest } from './manifest';
const imageSchema = z.object({
  name: z.string().max(200),
  data: z
    .string()
    .max(7_000_000)
    .regex(
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
      '仅支持 PNG、JPEG、WebP 图片',
    ),
});
const inputSchema = z
  .object({
    modelId: z.string().uuid(),
    skills: skillSelections.optional(),
    extensions: modesSchema.default({}),
    productionMode: z.enum(['auto', 'required']).default('auto'),
    requestId: z.string().uuid().optional(),
    replaceLastMessageId: z.string().uuid().optional(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).default('none'),
    content: z.string().trim().max(100_000).default(''),
    images: z.array(imageSchema).max(4).default([]),
  })
  .refine((v) => v.content.length > 0 || v.images.length > 0, '请输入消息或添加图片');
function validateImages(images: Attachment[]) {
  for (const image of images) {
    const [header, data] = image.data.split(',');
    const bytes = Buffer.from(data, 'base64');
    const valid = header.includes('/png')
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : header.includes('/jpeg')
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!valid || bytes.length > 5 * 1024 * 1024)
      throw new HttpError(400, '图片格式不正确，或超过 5 MB');
  }
}
const messageColumns =
  'm.harness_run AS runJson,m.id,m.role,m.content,m.images,m.extensions,m.skills,m.skill_reads AS skillReads,m.calls,m.production_mode AS productionMode,m.model_name AS modelName,m.status,m.created_at AS createdAt,m.duration_ms AS durationMs,m.error,u.input_tokens AS input,u.output_tokens AS output,u.total_tokens AS total';
function messages(ctx: Context, id: string): Message[] {
  const owner = ctx.db.get<{ user_id: string }>('SELECT user_id FROM conversations WHERE id=?', id);
  return ctx.db
    .all<
      Omit<Message, 'images' | 'extensions' | 'skills' | 'skillReads' | 'calls'> & {
        runJson: string | null;
        images: string;
        extensions: string;
        skills: string;
        skillReads: string;
        calls: string;
        input: number | null;
        output: number | null;
        total: number | null;
      }
    >(
      `SELECT ${messageColumns} FROM messages m LEFT JOIN usage u ON u.id=m.id WHERE m.conversation_id=? ORDER BY m.rowid`,
      id,
    )
    .map(({ input, output, total, runJson, ...m }) => {
      const calls: ExtensionCall[] = JSON.parse(m.calls).map((call: ExtensionCall) => {
        const row = ctx.db.get<{
          input: number | null;
          output: number | null;
          total: number | null;
          status: ExtensionCall['status'];
        }>(
          'SELECT input_tokens AS input,output_tokens AS output,total_tokens AS total,status FROM usage WHERE id=?',
          call.id,
        );
        return {
          ...call,
          status: row?.status ?? call.status,
          usage:
            row && row.input !== null && row.output !== null && row.total !== null
              ? { input: row.input, output: row.output, total: row.total }
              : null,
        };
      });
      return {
        ...m,
        ...(runJson ? { harnessRun: JSON.parse(runJson) } : {}),
        images: JSON.parse(m.images),
        extensions: JSON.parse(m.extensions),
        skills: JSON.parse(m.skills),
        skillReads: JSON.parse(m.skillReads),
        calls,
        ...(m.role === 'assistant'
          ? {
              artifacts: owner ? ctx.production.forMessage(owner.user_id, m.id) : [],
              productionDelivery: owner ? ctx.production.delivery(owner.user_id, m.id) : null,
              usage: calls.length
                ? aggregateCalls(calls)
                : input !== null && output !== null && total !== null
                  ? { input, output, total }
                  : null,
            }
          : {}),
      };
    });
}
/** Generation only consumes transcript text, images and applied user supplements. */
function taskHistory(ctx: Context, conversationId: string, exclude: string[]): Message[] {
  const rows = ctx.db.all<
    Pick<Message, 'id' | 'role' | 'content' | 'createdAt'> & {
      images: string;
      runJson: string | null;
    }
  >(
    "SELECT id,role,content,images,created_at AS createdAt,harness_run AS runJson FROM messages WHERE conversation_id=? AND status='complete' ORDER BY rowid",
    conversationId,
  );
  const history: Message[] = [];
  for (const { images, runJson, ...row } of rows) {
    if (exclude.includes(row.id)) continue;
    if (runJson) {
      const run = JSON.parse(runJson) as HarnessRun;
      const previous = history.at(-1);
      const notes = run.steering.filter((item) => item.applied && !item.receipt);
      if (previous?.role === 'user' && notes.length)
        previous.content +=
          '\n\n' + notes.map((item) => '本轮用户补充：' + item.content).join('\n');
    }
    history.push({ ...row, images: JSON.parse(images), status: 'complete' });
  }
  return history;
}

interface Generation {
  abort: AbortController;
  message: Message;
  listeners: Set<Response>;
  finished?: Promise<void>;
  execution?: HarnessExecution;
}
export function createChatFeature(maxConcurrentChats = DEFAULT_MAX_CONCURRENT_CHATS) {
  const limit = z.number().int().min(1).max(20).parse(maxConcurrentChats);
  return {
    name: 'chat',
    inject: ['db', 'http', 'models', 'kernel', 'extensions', 'production'],
    apply,
  };
  function apply(ctx: Context) {
    const router = Router();
    router.use('/conversations', requireUser);
    registerGroupRoutes(ctx, router);
    registerWorkspaceRoutes(ctx, router, resumeApproved);
    ctx.effect(() => registerHarnessTools(ctx));
    const active = new Map<string, Generation>();
    const userActive = new Map<string, Set<string>>();
    let stopping = false;
    const own = (id: string, userId: string) => {
      if (!ctx.db.get('SELECT id FROM conversations WHERE id=? AND user_id=?', id, userId))
        throw new HttpError(404, '对话不存在');
    };
    const snapshot = (id: string) => {
      const current = active.get(id)?.message;
      return messages(ctx, id).map((message) =>
        message.id === current?.id
          ? {
              ...current,
              artifacts: message.artifacts,
              productionDelivery: message.productionDelivery,
            }
          : message,
      );
    };
    const emit = (res: Response, data: StreamEvent) => {
      if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify(data) + '\n\n');
    };
    // Unexpected process restarts preserve checkpoint text and mark interrupted runs honestly.
    for (const saved of ctx.db.all<{ id: string; extensions: string; harness_run: string | null }>(
      "SELECT id,extensions,harness_run FROM messages WHERE status='streaming'",
    )) {
      const runs: NonNullable<Message['extensions']> = JSON.parse(saved.extensions);
      for (const run of runs) {
        if (run.status === 'deciding' || run.status === 'running') {
          run.status = 'error';
          run.error = '服务重启，拓展任务已中断';
        }
        for (const call of run.calls) if (call.status === 'streaming') call.status = 'error';
      }
      if (saved.harness_run) {
        const run = JSON.parse(saved.harness_run) as HarnessRun;
        run.phase = 'error';
        run.detail = '服务重启，任务已中断';
        for (const step of run.steps) if (step.status === 'running') step.status = 'error';
        ctx.db.run('UPDATE messages SET harness_run=? WHERE id=?', JSON.stringify(run), saved.id);
      }
      ctx.db.run(
        "UPDATE messages SET status='error',error='服务重启，回复已中断',extensions=? WHERE id=?",
        JSON.stringify(runs),
        saved.id,
      );
    }
    for (const saved of ctx.db.all<{ id: string; calls: string }>(
      "SELECT id,calls FROM messages WHERE status='error'",
    )) {
      const calls: ExtensionCall[] = JSON.parse(saved.calls);
      if (calls.some((call) => call.status === 'streaming')) {
        for (const call of calls) if (call.status === 'streaming') call.status = 'error';
        ctx.db.run('UPDATE messages SET calls=? WHERE id=?', JSON.stringify(calls), saved.id);
      }
    }
    ctx.db.run("UPDATE usage SET status='error' WHERE status='streaming'");
    router.get('/conversations', (req, res) => {
      const rows = ctx.db.all<{ id: string; title: string; updatedAt: string; harness: number }>(
        'SELECT id,title,updated_at AS updatedAt,color_slot AS colorSlot,group_id AS groupId,EXISTS(SELECT 1 FROM harness_workspaces w WHERE w.conversation_id=conversations.id AND w.user_id=conversations.user_id) AS harness FROM conversations WHERE user_id=? ORDER BY updated_at DESC,id',
        req.user!.id,
      );
      res.json(
        rows.map((row) => ({
          ...row,
          generating: active.has(row.id),
          harness: Boolean(row.harness),
        })),
      );
    });
    router.post('/conversations', (req, res) => {
      const { groupId } = z
        .object({ groupId: z.string().uuid().nullable().default(null) })
        .parse(req.body ?? {});
      if (groupId) ownGroup(ctx, groupId, req.user!.id);
      const id = randomUUID();
      ctx.db.transaction(() => {
        ctx.db.run(
          'INSERT INTO conversations(id,user_id,title,updated_at,group_id) VALUES(?,?,?,?,?)',
          id,
          req.user!.id,
          '新对话',
          new Date().toISOString(),
          groupId,
        );
        initializeWorkspace(ctx, req.user!.id, id);
      });
      res.status(201).json({ id });
    });
    router.get('/conversations/:id', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      res.json({ messages: snapshot(id), harness: isHarnessConversation(ctx, req.user!.id, id) });
    });
    router.get('/conversations/:id/skills', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      res.json(
        JSON.parse(
          ctx.db.get<{ skills: string }>('SELECT skills FROM conversations WHERE id=?', id)!.skills,
        ),
      );
    });
    router.get('/conversations/:id/events', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      // A fresh authoritative snapshot makes reconnects independent of missed delta events.
      emit(res, {
        type: 'snapshot',
        messages: snapshot(id),
        harness: isHarnessConversation(ctx, req.user!.id, id),
      });
      const generation = active.get(id);
      if (!generation) {
        res.end();
        return;
      }
      generation.listeners.add(res);
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
      }, 15_000);
      res.on('close', () => {
        clearInterval(heartbeat);
        generation.listeners.delete(res);
        // Losing a viewer is not a request to cancel the server-owned generation.
      });
    });
    router.patch('/conversations/:id', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      const { title, colorSlot, groupId } = z
        .object({
          title: z.string().trim().min(1).max(100).optional(),
          colorSlot: z.number().int().min(0).max(63).nullable().optional(),
          groupId: z.string().uuid().nullable().optional(),
        })
        .refine(
          (value) =>
            value.title !== undefined ||
            value.colorSlot !== undefined ||
            value.groupId !== undefined,
        )
        .parse(req.body);
      if (groupId) ownGroup(ctx, groupId, req.user!.id);
      ctx.db.transaction(() => {
        if (title !== undefined)
          ctx.db.run(
            'UPDATE conversations SET title=? WHERE id=? AND user_id=?',
            title,
            id,
            req.user!.id,
          );
        if (colorSlot !== undefined)
          ctx.db.run(
            'UPDATE conversations SET color_slot=? WHERE id=? AND user_id=?',
            colorSlot,
            id,
            req.user!.id,
          );
        if (groupId !== undefined)
          ctx.db.run(
            'UPDATE conversations SET group_id=? WHERE id=? AND user_id=?',
            groupId,
            id,
            req.user!.id,
          );
        if (groupId) ctx.production.adoptConversationArtifacts(req.user!.id, id, groupId);
      });
      res.json({ ok: true });
    });
    router.delete('/conversations/:id', async (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      if (active.has(id)) throw new HttpError(409, '请先停止当前回复');
      const legacy = !isHarnessConversation(ctx, req.user!.id, id);
      ctx.db.transaction(() => {
        ctx.production.removeConversationArtifacts(req.user!.id, id);
        ctx.db.run('DELETE FROM conversations WHERE id=? AND user_id=?', id, req.user!.id);
      });
      if (legacy) await ctx.extensions.removeMemoryScope(req.user!, 'session', id);
      res.json({ ok: true });
    });
    router.post('/conversations/:id/stop', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      active.get(id)?.abort.abort();
      res.json({ ok: true });
    });
    router.post('/conversations/:id/steer', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      const input = z
        .object({
          messageId: z.string().uuid(),
          requestId: z.string().uuid(),
          content: z.string().trim().min(1).max(4000),
        })
        .parse(req.body);
      const job = active.get(id);
      if (!job?.execution || job.message.id !== input.messageId || job.abort.signal.aborted) {
        throw new HttpError(409, '这次回答已经结束，请作为新提问发送');
      }
      const execution = job.execution;
      let approved: WorkspaceApproval | undefined;
      const receipt = ctx.db.transaction(() =>
        execution.steer(input.requestId, input.content, () =>
          applyWorkspaceCommand(ctx, req.user!.id, id, input.content, (grant) => {
            approved = grant;
          }),
        ),
      );
      if (approved) {
        try {
          resumeApproved(req.user!, approved);
        } catch (error) {
          execution.activity(
            (error instanceof HttpError ? error.message : '任务暂未继续') + '，可在授权卡片继续。',
          );
        }
      }
      res.status(202).json({ ok: true, receipt });
    });
    function resumeApproved(user: User, grant: WorkspaceApproval) {
      const id = grant.targetConversationId;
      own(id, user.id);
      // Recheck both endpoints' current project membership at consumption time.
      const authorized = ctx.db.get(
        `SELECT 1 FROM harness_access a JOIN conversations origin ON origin.id=a.source_conversation_id
         JOIN conversations target ON target.id=a.target_conversation_id
         WHERE a.id=? AND a.user_id=? AND target.user_id=? AND origin.user_id=? AND target.id=?
         AND a.group_id=origin.group_id AND a.group_id=target.group_id AND a.status='approved'`,
        grant.id,
        user.id,
        user.id,
        user.id,
        id,
      );
      if (!authorized) throw new HttpError(404, '文件授权已不可用');
      if (ctx.db.get('SELECT 1 FROM messages WHERE id=? AND conversation_id=?', grant.id, id))
        return;
      const original = ctx.db.get<{ run: string | null; content: string }>(
        `SELECT a.harness_run AS run,
           (SELECT u.content FROM messages u WHERE u.conversation_id=a.conversation_id AND u.role='user'
              AND u.rowid<a.rowid ORDER BY u.rowid DESC LIMIT 1) AS content
         FROM messages a WHERE a.id=? AND a.conversation_id=? AND a.role='assistant'`,
        grant.taskId,
        id,
      );
      if (!original?.run) throw new HttpError(409, '原任务已被替换，请在目标对话中继续');
      const state = JSON.parse(original.run) as HarnessRun;
      const note =
        '文件访问已获批准，仅用于本任务。可用 workspace_read 读取文件 ' +
        grant.documentId +
        ' 的第 ' +
        grant.version +
        ' 版。授权用途：' +
        grant.purpose;
      const job = active.get(id);
      if (job?.message.id === grant.taskId && job.execution && !job.abort.signal.aborted) {
        job.execution.steer(grant.id, note);
        return;
      }
      if (state.steering.some((item) => item.id === grant.id && item.applied)) return;
      submit(
        user,
        id,
        {
          requestId: grant.id,
          modelId: state.modelId,
          reasoningEffort: state.effort,
          content:
            note +
            '\n请继续之前等待资料的任务，复用已完成的工作。原问题：\n' +
            original.content.slice(0, 16000),
        },
        () => {},
      );
    }
    router.post('/conversations/:id/approvals/:approvalId/continue', (req, res) => {
      const grant = ctx.db.get<WorkspaceApproval>(
        `SELECT id,task_id AS taskId,target_conversation_id AS targetConversationId,purpose,
         document_id AS documentId,version FROM harness_access WHERE id=? AND target_conversation_id=? AND user_id=? AND status='approved'`,
        String(req.params.approvalId),
        String(req.params.id),
        req.user!.id,
      );
      if (!grant) throw new HttpError(404, '授权不存在');
      resumeApproved(req.user!, grant);
      res.status(202).json({ ok: true });
    });
    router.post('/conversations/:id/messages', (req, res) => {
      submit(req.user!, String(req.params.id), req.body, (messageId, differentContent) => {
        res
          .status(202)
          .json({ messageId, ...(differentContent ? { replayedWithDifferentContent: true } : {}) });
      });
    });
    function submit(
      user: User,
      id: string,
      body: unknown,
      accepted: (messageId: string, differentContent?: boolean) => void,
    ) {
      if (stopping) throw new HttpError(503, '服务正在重启，请稍后重试');
      own(id, user.id);
      if (!isHarnessConversation(ctx, user.id, id))
        throw new HttpError(409, '历史对话仅供查看，请新建对话');
      const input = inputSchema.parse(body);
      const messageId = input.requestId ?? randomUUID();
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            ...input,
            requestId: messageId,
            extensions: Object.entries(input.extensions).sort(([a], [b]) => a.localeCompare(b)),
          }),
        )
        .digest('hex');
      const recorded = ctx.db.get<{ conversation_id: string; fingerprint: string }>(
        'SELECT conversation_id,fingerprint FROM harness_submissions WHERE request_id=?',
        messageId,
      );
      if (recorded && recorded.conversation_id !== id) throw new HttpError(409, '请求标识已被使用');
      const recordAdmission = () =>
        ctx.db.run(
          'INSERT INTO harness_submissions(request_id,conversation_id,fingerprint) VALUES(?,?,?)',
          messageId,
          id,
          fingerprint,
        );
      // A retried submission reuses its assistant ID, so one request cannot start two paid calls.
      const existing = ctx.db.get<{ conversation_id: string; role: string }>(
        'SELECT conversation_id,role FROM messages WHERE id=?',
        messageId,
      );
      if (existing) {
        if (existing.conversation_id !== id || existing.role !== 'assistant')
          throw new HttpError(409, '请求标识已被使用');
        accepted(messageId, !!recorded && recorded.fingerprint !== fingerprint);
        return;
      }
      if (recorded) throw new HttpError(409, '这次回答已被替换，请使用新的请求标识');
      if (!input.replaceLastMessageId && !input.images.length && !active.has(id)) {
        let approved: WorkspaceApproval | undefined;
        const receipt = ctx.db.transaction(() => {
          const result = applyWorkspaceCommand(ctx, user.id, id, input.content, (grant) => {
            approved = grant;
          });
          if (result === undefined) return;
          recordAdmission();
          const now = new Date().toISOString();
          const insert =
            'INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)';
          ctx.db.run(insert, randomUUID(), id, 'user', input.content, now);
          ctx.db.run(insert, messageId, id, 'assistant', result, now);
          ctx.db.run(
            'UPDATE conversations SET updated_at=? WHERE id=? AND user_id=?',
            now,
            id,
            user.id,
          );
          return result;
        });
        if (receipt !== undefined) {
          if (approved) {
            try {
              resumeApproved(user, approved);
            } catch (error) {
              ctx.db.run(
                'UPDATE messages SET content=? WHERE id=?',
                receipt +
                  '\n' +
                  (error instanceof HttpError ? error.message : '任务暂未继续') +
                  '，可在授权卡片继续。',
                messageId,
              );
            }
          }
          accepted(messageId);
          return;
        }
      }
      validateImages(input.images);
      const model = ctx.models.authorize(user, input.modelId, 'llm');
      prepareConversationTools(ctx, user, input.modelId, input.content, input.productionMode);
      const selectedSkills =
        input.skills ??
        skillSelections.parse(
          JSON.parse(
            ctx.db.get<{ skills: string }>('SELECT skills FROM conversations WHERE id=?', id)!
              .skills,
          ),
        );
      const skillPlan = ctx.extensions.planSkills(user, selectedSkills);
      const session = skillPlan ? ctx.extensions.openSkills(user, skillPlan) : undefined;
      const skillContext = session?.prepare();
      if (session?.tools().length && !model.toolCalling)
        throw new HttpError(400, '所选 Skill 包含参考文档，请选择已启用工具调用的模型');
      const skillSnapshot: SelectedSkill[] =
        skillPlan?.skills.map(({ id, version, title, scope }) => ({ id, version, title, scope })) ??
        [];
      const extensionPlan = ctx.extensions.plan(user, input.extensions, input.modelId);
      if (active.has(id)) throw new HttpError(409, '此对话已有回复正在生成，请先停止或等待完成');
      if ((userActive.get(user.id)?.size ?? 0) >= limit)
        throw new HttpError(
          409,
          `同时最多生成 ${limit} 个聊天回复，请等待其中一个完成或停止后再试`,
        );
      const latest = input.replaceLastMessageId
        ? ctx.db.all<{ id: string; role: Message['role']; status: Message['status'] }>(
            'SELECT id,role,status FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 2',
            id,
          )
        : [];
      if (
        input.replaceLastMessageId &&
        (latest.length !== 2 ||
          latest[0].role !== 'assistant' ||
          latest[1].role !== 'user' ||
          latest[1].id !== input.replaceLastMessageId ||
          latest[0].status === 'streaming')
      )
        throw new HttpError(409, '只能修改最后一次提问，请刷新对话后重试');
      const history = taskHistory(
        ctx,
        id,
        latest.map((message) => message.id),
      );
      if (
        !model.vision &&
        (input.images.length || history.some((message) => message.images.length))
      )
        throw new HttpError(400, '此对话包含图片，请选择支持图片的模型');
      if (
        history.length > 2000 ||
        history.reduce(
          (n, message) =>
            n +
            message.content.length +
            message.images.reduce((s, image) => s + image.data.length, 0),
          0,
        ) > 30_000_000
      )
        throw new HttpError(400, '对话较长，请新建对话后继续');
      const now = new Date().toISOString();
      const generation: Generation = {
        abort: new AbortController(),
        listeners: new Set(),
        message: {
          id: messageId,
          role: 'assistant',
          skills: skillSnapshot,
          skillReads: session?.reads ?? [],
          calls: [],
          content: '',
          images: [],
          modelName: model.label,
          status: 'streaming',
          productionMode: input.productionMode,
          createdAt: now,
        },
      };
      const broadcast = (event: StreamEvent) => {
        for (const listener of generation.listeners) {
          try {
            emit(listener, event);
          } catch {
            listener.destroy();
          }
        }
      };
      let execution: HarnessExecution;
      let recorder: ContextRecorder | undefined;
      ctx.db.transaction(() => {
        recordAdmission();
        if (input.replaceLastMessageId) {
          ctx.db.run('DELETE FROM messages WHERE id=? AND conversation_id=?', latest[0].id, id);
          ctx.db.run(
            'UPDATE messages SET content=?,images=?,skills=?,production_mode=? WHERE id=? AND conversation_id=?',
            input.content,
            JSON.stringify(input.images),
            JSON.stringify(skillSnapshot),
            input.productionMode,
            input.replaceLastMessageId,
            id,
          );
        } else {
          ctx.db.run(
            'INSERT INTO messages(id,conversation_id,role,content,images,created_at,skills,production_mode) VALUES(?,?,?,?,?,?,?,?)',
            randomUUID(),
            id,
            'user',
            input.content,
            JSON.stringify(input.images),
            now,
            JSON.stringify(skillSnapshot),
            input.productionMode,
          );
        }
        ctx.db.run(
          'INSERT INTO messages(id,conversation_id,role,content,model_name,status,created_at,production_mode) VALUES(?,?,?,?,?,?,?,?)',
          messageId,
          id,
          'assistant',
          '',
          model.label,
          'streaming',
          now,
          input.productionMode,
        );
        ctx.db.run(
          'UPDATE messages SET skills=?,skill_reads=? WHERE id=?',
          JSON.stringify(skillSnapshot),
          JSON.stringify(session?.reads ?? []),
          messageId,
        );
        ctx.db.run(
          'UPDATE conversations SET skills=? WHERE id=?',
          JSON.stringify(skillSnapshot.filter((skill) => skill.scope === 'conversation')),
          id,
        );
        ctx.db.run(
          'INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)',
          messageId,
          user.id,
          model.label,
          null,
          null,
          null,
          'streaming',
          now,
        );
        ctx.db.run(
          "UPDATE conversations SET updated_at=?,title=CASE WHEN title='新对话' THEN ? ELSE title END WHERE id=?",
          now,
          input.content.slice(0, 40) || '图片对话',
          id,
        );
        execution = new HarnessExecution(
          ctx,
          messageId,
          input.modelId,
          input.reasoningEffort,
          broadcast,
        );
        generation.execution = execution;
        generation.message.harnessRun = execution.state;
        recorder = ctx.extensions.observeContext({
          user,
          conversationId: id,
          messageId,
          modelId: input.modelId,
          modelName: model.label,
          createdAt: now,
          reasoningEffort: input.reasoningEffort,
          replacesMessageId: latest[0]?.id,
          history,
          current: { role: 'user', content: input.content, images: input.images },
        });
      });
      active.set(id, generation);
      const userJobs = userActive.get(user.id) ?? new Set<string>();
      userJobs.add(id);
      userActive.set(user.id, userJobs);
      accepted(messageId);
      generation.finished = executeHarness(ctx, {
        conversationId: id,
        user,
        model,
        input,
        history,
        extensionPlan,
        session,
        skillContext,
        recorder,
        message: generation.message,
        abort: generation.abort,
        execution: execution!,
        broadcast,
      }).finally(() => {
        active.delete(id);
        userJobs.delete(id);
        if (!userJobs.size) userActive.delete(user.id);
        for (const listener of generation.listeners) listener.end();
      });
      // Observe failures in background persistence without exposing provider secrets.
      void generation.finished.catch(() => console.error('Chat background persistence failed'));
    }
    ctx.effect(() => ctx.http.register(router));
    ctx.effect(() =>
      ctx.kernel.onShutdown(async () => {
        stopping = true;
        const jobs = [...active.values()];
        for (const job of jobs)
          job.abort.abort(new HttpError(503, '服务重启，回复已中断。可手动重试。'));
        await Promise.allSettled(jobs.map((job) => job.finished));
      }),
    );
    ctx.on('dispose', () => {
      for (const job of active.values()) job.abort.abort();
    });
  }
}
export const server = createChatFeature();
