import { Router, type Response } from 'express';
import type { Context } from 'cordis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
import type { Message, StreamEvent, Attachment } from '../../shared/types';
import type { TokenUsage, ProviderMessage } from '../../adapters/registry';
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
    requestId: z.string().uuid().optional(),
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
  'm.id,m.role,m.content,m.images,m.model_name AS modelName,m.status,m.created_at AS createdAt,m.duration_ms AS durationMs,u.input_tokens AS input,u.output_tokens AS output,u.total_tokens AS total';
function messages(ctx: Context, id: string): Message[] {
  return ctx.db
    .all<
      Omit<Message, 'images'> & {
        images: string;
        input: number | null;
        output: number | null;
        total: number | null;
      }
    >(
      `SELECT ${messageColumns} FROM messages m LEFT JOIN usage u ON u.id=m.id WHERE m.conversation_id=? ORDER BY m.rowid`,
      id,
    )
    .map(({ input, output, total, ...m }) => ({
      ...m,
      images: JSON.parse(m.images),
      ...(m.role === 'assistant'
        ? {
            usage:
              input !== null && output !== null && total !== null ? { input, output, total } : null,
          }
        : {}),
    }));
}
interface Generation {
  abort: AbortController;
  message: Message;
  listeners: Set<Response>;
  finished?: Promise<void>;
}
export const server = {
  name: 'chat',
  inject: ['db', 'http', 'models', 'kernel'],
  apply(ctx: Context) {
    const router = Router();
    router.use('/conversations', requireUser);
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
    ctx.db.run("UPDATE messages SET status='error' WHERE status='streaming'");
    ctx.db.run("UPDATE usage SET status='error' WHERE status='streaming'");
    router.get('/conversations', (req, res) => {
      const rows = ctx.db.all<{ id: string; title: string; updatedAt: string }>(
        'SELECT id,title,updated_at AS updatedAt,color_slot AS colorSlot FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 300',
        req.user!.id,
      );
      res.json(rows.map((row) => ({ ...row, generating: active.has(row.id) })));
    });
    router.post('/conversations', (req, res) => {
      const id = randomUUID();
      ctx.db.run(
        'INSERT INTO conversations(id,user_id,title,updated_at) VALUES(?,?,?,?)',
        id,
        req.user!.id,
        '新对话',
        new Date().toISOString(),
      );
      res.status(201).json({ id });
    });
    router.get('/conversations/:id', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      res.json({ messages: snapshot(id) });
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
      const { title, colorSlot } = z
        .object({
          title: z.string().trim().min(1).max(100).optional(),
          colorSlot: z.number().int().min(0).max(63).nullable().optional(),
        })
        .refine((value) => value.title !== undefined || value.colorSlot !== undefined)
        .parse(req.body);
      if (title !== undefined) ctx.db.run('UPDATE conversations SET title=? WHERE id=?', title, id);
      if (colorSlot !== undefined)
        ctx.db.run('UPDATE conversations SET color_slot=? WHERE id=?', colorSlot, id);
      res.json({ ok: true });
    });
    router.delete('/conversations/:id', (req, res) => {
      const id = String(req.params.id);
      own(id, req.user!.id);
      if (active.has(id)) throw new HttpError(409, '请先停止当前回复');
      ctx.db.run('DELETE FROM conversations WHERE id=?', id);
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
      const model = ctx.models.authorize(user, input.modelId);
      if (active.has(id) || userActive.has(user.id))
        throw new HttpError(409, '已有回复正在生成，请先停止或等待完成');
      const history = messages(ctx, id).filter((message) => message.status === 'complete');
      if (
        !model.vision &&
        (input.images.length || history.some((message) => message.images.length))
      )
        throw new HttpError(400, '此对话包含图片，请选择支持图片的模型');
      if (
        history.length > 200 ||
        history.reduce(
          (n, message) =>
            n +
            message.content.length +
            message.images.reduce((s, image) => s + image.data.length, 0),
          0,
        ) > 30_000_000
      )
        throw new HttpError(400, '对话较长，请新建对话后继续');
      const connection = ctx.models.connection(model.providerId);
      const adapter = ctx.models.adapter(connection.apiMode);
      const now = new Date().toISOString();
      const generation: Generation = {
        abort: new AbortController(),
        listeners: new Set(),
        message: {
          id: messageId,
          role: 'assistant',
          content: '',
          images: [],
          modelName: model.label,
          status: 'streaming',
          createdAt: now,
        },
      };
      ctx.db.transaction(() => {
        ctx.db.run(
          'INSERT INTO messages(id,conversation_id,role,content,images,created_at) VALUES(?,?,?,?,?,?)',
          randomUUID(),
          id,
          'user',
          input.content,
          JSON.stringify(input.images),
          now,
        );
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
        let usage: TokenUsage | undefined;
        let status: Message['status'] = 'complete';
        let checkpoint = Date.now();
        try {
          for await (const chunk of adapter.generate(
            connection,
            model.name,
            context,
            AbortSignal.any([generation.abort.signal, AbortSignal.timeout(180_000)]),
            input.reasoningEffort,
          )) {
            if (chunk.type === 'usage') usage = chunk.usage;
            else {
              generation.message.content += chunk.text;
              if (generation.message.content.length > 2_000_000)
                throw new HttpError(502, '回复过长，已停止生成');
              broadcast({ type: 'delta', messageId, text: chunk.text });
              if (Date.now() - checkpoint > 1500) {
                ctx.db.run(
                  'UPDATE messages SET content=? WHERE id=?',
                  generation.message.content,
                  messageId,
                );
                checkpoint = Date.now();
              }
            }
          }
        } catch (error) {
          status = generation.abort.signal.aborted ? 'cancelled' : 'error';
          if (status === 'error')
            broadcast({
              type: 'error',
              message:
                error instanceof HttpError
                  ? error.message
                  : '模型连接失败或超时，请检查来源配置后重试',
            });
        } finally {
          generation.message.status = status;
          generation.message.usage = usage ?? null;
          const durationMs = Math.round(performance.now() - started);
          generation.message.durationMs = durationMs;
          try {
            ctx.db.transaction(() => {
              ctx.db.run(
                'UPDATE messages SET content=?,status=?,duration_ms=? WHERE id=?',
                generation.message.content,
                status,
                durationMs,
                messageId,
              );
              ctx.db.run(
                'UPDATE usage SET input_tokens=?,output_tokens=?,total_tokens=?,status=? WHERE id=?',
                usage?.input ?? null,
                usage?.output ?? null,
                usage?.total ?? null,
                status,
                messageId,
              );
              ctx.db.run(
                'UPDATE conversations SET updated_at=? WHERE id=?',
                new Date().toISOString(),
                id,
              );
            });
            broadcast({ type: 'done', message: { ...generation.message } });
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
