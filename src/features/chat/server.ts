import { skillSelections } from '../extensions/skill-runtime';
import type { ContextRecorder } from '../extensions/context-observer';
import { appendMemoryBlocks } from '../extensions/memory-context';
import type { SelectedSkill, SkillRead } from '../skills/types';
import { generateReply, aggregateCalls } from './skill-generation';
import { generationDeadline } from './generation-deadline';
import type { ExtensionCall } from '../../shared/types';
import { modesSchema } from '../extensions/server';
import { Router, type Response } from 'express';
import type { Context } from 'cordis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
import { ownGroup, registerGroupRoutes } from './groups-server';
import type { Message, StreamEvent, Attachment } from '../../shared/types';
import type { ProviderMessage } from '../../adapters/registry';
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
    requestId: z.string().uuid().optional(),
    replaceLastMessageId: z.string().uuid().optional(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']).default('none'),
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
  'm.id,m.role,m.content,m.images,m.extensions,m.skills,m.skill_reads AS skillReads,m.calls,m.model_name AS modelName,m.status,m.created_at AS createdAt,m.duration_ms AS durationMs,m.error,u.input_tokens AS input,u.output_tokens AS output,u.total_tokens AS total';
function messages(ctx: Context, id: string): Message[] {
  return ctx.db
    .all<
      Omit<Message, 'images' | 'extensions' | 'skills' | 'skillReads' | 'calls'> & {
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
    .map(({ input, output, total, ...m }) => {
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
        images: JSON.parse(m.images),
        extensions: JSON.parse(m.extensions),
        skills: JSON.parse(m.skills),
        skillReads: JSON.parse(m.skillReads),
        calls,
        ...(m.role === 'assistant'
          ? {
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
interface Generation {
  abort: AbortController;
  message: Message;
  listeners: Set<Response>;
  finished?: Promise<void>;
}
export const server = {
  name: 'chat',
  inject: ['db', 'http', 'models', 'kernel', 'extensions'],
  apply(ctx: Context) {
    const router = Router();
    router.use('/conversations', requireUser);
    registerGroupRoutes(ctx, router);
    const active = new Map<string, Generation>();
    const userActive = new Set<string>();
    let stopping = false;
    const own = (id: string, userId: string) => {
      if (!ctx.db.get('SELECT id FROM conversations WHERE id=? AND user_id=?', id, userId))
        throw new HttpError(404, '对话不存在');
    };
    const snapshot = (id: string) => {
      const current = active.get(id)?.message;
      return messages(ctx, id).map((message) =>
        message.id === current?.id ? { ...current } : message,
      );
    };
    const emit = (res: Response, data: StreamEvent) => {
      if (!res.destroyed && !res.writableEnded) res.write('data: ' + JSON.stringify(data) + '\n\n');
    };
    // Unexpected process restarts preserve checkpoint text and mark interrupted runs honestly.
    for (const saved of ctx.db.all<{ id: string; extensions: string }>(
      "SELECT id,extensions FROM messages WHERE status='streaming'",
    )) {
      const runs: NonNullable<Message['extensions']> = JSON.parse(saved.extensions);
      for (const run of runs) {
        if (run.status === 'deciding' || run.status === 'running') {
          run.status = 'error';
          run.error = '服务重启，拓展任务已中断';
        }
        for (const call of run.calls) if (call.status === 'streaming') call.status = 'error';
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
      const rows = ctx.db.all<{ id: string; title: string; updatedAt: string }>(
        'SELECT id,title,updated_at AS updatedAt,color_slot AS colorSlot,group_id AS groupId FROM conversations WHERE user_id=? ORDER BY updated_at DESC,id',
        req.user!.id,
      );
      res.json(rows.map((row) => ({ ...row, generating: active.has(row.id) })));
    });
    router.post('/conversations', (req, res) => {
      const { groupId } = z
        .object({ groupId: z.string().uuid().nullable().default(null) })
        .parse(req.body ?? {});
      if (groupId) ownGroup(ctx, groupId, req.user!.id);
      const id = randomUUID();
      ctx.db.run(
        'INSERT INTO conversations(id,user_id,title,updated_at,group_id) VALUES(?,?,?,?,?)',
        id,
        req.user!.id,
        '新对话',
        new Date().toISOString(),
        groupId,
      );
      res.status(201).json({ id });
    });
    router.get('/conversations/:id', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      res.json({ messages: snapshot(id) });
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
      emit(res, { type: 'snapshot', messages: snapshot(id) });
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
      });
      res.json({ ok: true });
    });
    router.delete('/conversations/:id', async (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      if (active.has(id)) throw new HttpError(409, '请先停止当前回复');
      ctx.db.run('DELETE FROM conversations WHERE id=? AND user_id=?', id, req.user!.id);
      await ctx.extensions.removeMemoryScope(req.user!, 'session', id);
      res.json({ ok: true });
    });
    router.post('/conversations/:id/stop', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      active.get(id)?.abort.abort();
      res.json({ ok: true });
    });
    router.post('/conversations/:id/messages', (req, res) => {
      if (stopping) throw new HttpError(503, '服务正在重启，请稍后重试');
      const id = String(req.params.id);
      const user = req.user!;
      own(id, user.id);
      const input = inputSchema.parse(req.body);
      const messageId = input.requestId ?? randomUUID();
      // A retried submission reuses its assistant ID, so one request cannot start two paid calls.
      const existing = ctx.db.get<{ conversation_id: string; role: string }>(
        'SELECT conversation_id,role FROM messages WHERE id=?',
        messageId,
      );
      if (existing) {
        if (existing.conversation_id !== id || existing.role !== 'assistant')
          throw new HttpError(409, '请求标识已被使用');
        res.status(202).json({ messageId });
        return;
      }
      validateImages(input.images);
      const model = ctx.models.authorize(user, input.modelId, 'llm');
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
      if (active.has(id) || userActive.has(user.id))
        throw new HttpError(409, '已有回复正在生成，请先停止或等待完成');
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
      const history = messages(ctx, id).filter(
        (message) =>
          message.status === 'complete' && !latest.some((tail) => tail.id === message.id),
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
      const groupId =
        ctx.db.get<{ groupId: string | null }>(
          'SELECT group_id AS groupId FROM conversations WHERE id=? AND user_id=?',
          id,
          user.id,
        )?.groupId ?? null;
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
          createdAt: now,
        },
      };
      let recorder: ContextRecorder | undefined;
      ctx.db.transaction(() => {
        if (input.replaceLastMessageId) {
          ctx.db.run('DELETE FROM messages WHERE id=? AND conversation_id=?', latest[0].id, id);
          ctx.db.run(
            'UPDATE messages SET content=?,images=?,skills=? WHERE id=? AND conversation_id=?',
            input.content,
            JSON.stringify(input.images),
            JSON.stringify(skillSnapshot),
            input.replaceLastMessageId,
            id,
          );
        } else {
          ctx.db.run(
            'INSERT INTO messages(id,conversation_id,role,content,images,created_at,skills) VALUES(?,?,?,?,?,?,?)',
            randomUUID(),
            id,
            'user',
            input.content,
            JSON.stringify(input.images),
            now,
            JSON.stringify(skillSnapshot),
          );
        }
        ctx.db.run(
          'INSERT INTO messages(id,conversation_id,role,content,model_name,status,created_at) VALUES(?,?,?,?,?,?,?)',
          messageId,
          id,
          'assistant',
          '',
          model.label,
          'streaming',
          now,
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
      userActive.add(user.id);
      res.status(202).json({ messageId });
      const context: ProviderMessage[] = [
        ...history.map((message) => ({
          role: message.role,
          content: message.content,
          images: message.images,
        })),
        { role: 'user', content: input.content, images: input.images },
      ];
      const broadcast = (event: StreamEvent) => {
        for (const listener of generation.listeners) {
          try {
            emit(listener, event);
          } catch {
            listener.destroy();
          }
        }
      };
      generation.finished = (async () => {
        const started = performance.now();

        let status: Message['status'] = 'complete';
        let checkpoint = Date.now();
        const deadline = generationDeadline(generation.abort.signal, skillPlan?.signal);
        try {
          const signal = deadline.signal;
          if (input.replaceLastMessageId) {
            await ctx.extensions.invalidateMemory(user, id, input.replaceLastMessageId);
            if (latest[0]?.id) await ctx.extensions.invalidateMemory(user, id, latest[0].id);
          }
          const memory = await ctx.extensions.prepareMemory({
            user,
            conversationId: id,
            messageId,
            groupId,
            history,
            current: input.content,
            signal,
          });
          deadline.touch();
          const prepared = await ctx.extensions.prepare(
            user,
            extensionPlan,
            context,
            signal,
            (extensions) => {
              deadline.touch();
              generation.message.extensions = extensions;
              ctx.db.run(
                'UPDATE messages SET extensions=? WHERE id=?',
                JSON.stringify(extensions),
                messageId,
              );
              broadcast({ type: 'extensions', messageId, extensions });
            },
          );
          signal.throwIfAborted();
          if (skillContext)
            prepared[prepared.length - 1] = {
              ...prepared[prepared.length - 1],
              content: `${prepared[prepared.length - 1].content}\n\n${skillContext}`,
            };
          const memoryInput = appendMemoryBlocks(prepared.at(-1)!.content, memory?.blocks ?? []);
          prepared[prepared.length - 1] = { ...prepared.at(-1)!, content: memoryInput.content };
          const processed = await ctx.extensions.prepareContext({
            user,
            conversationId: id,
            messageId,
            modelId: input.modelId,
            modelName: model.label,
            createdAt: now,
            reasoningEffort: input.reasoningEffort,
            history,
            current: context.at(-1)!,
            messages: prepared,
            signal,
          });
          deadline.touch();
          signal.throwIfAborted();
          if (processed.messages.length > 201)
            throw new HttpError(400, '对话较长，压缩未能缩减历史；请调整上下文压缩设置或新建对话');
          await generateReply(ctx, {
            user,
            modelId: input.modelId,
            messageId,
            messages: processed.messages,
            compression: processed.compression,
            signal,
            session,
            recorder,
            memory,
            memoryRanges: memoryInput.ranges,
            effort: input.reasoningEffort,
            calls: generation.message.calls!,
            progress: (skillReads: SkillRead[], calls: ExtensionCall[]) => {
              deadline.touch();
              generation.message.skillReads = [...skillReads];
              ctx.db.run(
                'UPDATE messages SET skill_reads=?,calls=? WHERE id=?',
                JSON.stringify(skillReads),
                JSON.stringify(calls),
                messageId,
              );
              broadcast({ type: 'skill-progress', messageId, skillReads, calls });
            },
            text: (text) => {
              deadline.touch();
              generation.message.content += text;
              if (generation.message.content.length > 2_000_000)
                throw new HttpError(502, '回复过长，已停止生成');
              broadcast({ type: 'delta', messageId, text });
              if (Date.now() - checkpoint > 1500) {
                ctx.db.run(
                  'UPDATE messages SET content=? WHERE id=?',
                  generation.message.content,
                  messageId,
                );
                checkpoint = Date.now();
              }
            },
          });
        } catch (error) {
          status = generation.abort.signal.aborted ? 'cancelled' : 'error';
          if (status === 'error') {
            generation.message.error =
              deadline.signal.reason instanceof HttpError
                ? deadline.signal.reason.message
                : error instanceof HttpError
                  ? error.message
                  : '模型连接失败，请检查来源配置后重试';
            broadcast({
              type: 'error',
              message: generation.message.error,
            });
          }
        } finally {
          deadline.close();
          generation.message.status = status;
          generation.message.usage = aggregateCalls(generation.message.calls ?? []);
          const durationMs = Math.round(performance.now() - started);
          generation.message.durationMs = durationMs;
          try {
            ctx.db.transaction(() => {
              ctx.db.run(
                'UPDATE messages SET content=?,status=?,duration_ms=?,error=? WHERE id=?',
                generation.message.content,
                status,
                durationMs,
                generation.message.error ?? null,
                messageId,
              );
              if (!generation.message.calls?.length)
                ctx.db.run('UPDATE usage SET status=? WHERE id=?', status, messageId);
              ctx.db.run(
                'UPDATE conversations SET updated_at=? WHERE id=?',
                new Date().toISOString(),
                id,
              );
            });
            recorder?.finish(generation.message);
            broadcast({ type: 'done', message: { ...generation.message } });
            ctx.extensions.completeContext({
              user,
              conversationId: id,
              messageId,
              current: input.content,
              response: { ...generation.message },
            });
            ctx.extensions.completeMemory({
              user,
              conversationId: id,
              messageId,
              groupId,
              history,
              current: input.content,
              response: { ...generation.message },
            });
          } finally {
            active.delete(id);
            userActive.delete(user.id);
            for (const listener of generation.listeners) listener.end();
          }
        }
      })();
      // Observe failures in background persistence without exposing provider secrets.
      void generation.finished.catch(() => console.error('Chat background persistence failed'));
    });
    ctx.effect(() => ctx.http.register(router));
    ctx.effect(() =>
      ctx.kernel.onShutdown(async () => {
        stopping = true;
        const jobs = [...active.values()];
        for (const job of jobs) job.abort.abort();
        await Promise.allSettled(jobs.map((job) => job.finished));
      }),
    );
    ctx.on('dispose', () => {
      for (const job of active.values()) job.abort.abort();
    });
  },
};
