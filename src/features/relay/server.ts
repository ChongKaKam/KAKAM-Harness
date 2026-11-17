import { randomUUID } from 'node:crypto';
import { raw, Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
import { RelayAttachmentFiles } from './attachment-files';
import { RelayStore } from './store';
import { relayLimits } from './types';
export { manifest } from './manifest';

const cardSchema = z.object({
  title: z.string().trim().max(relayLimits.title),
  content: z
    .string()
    .max(relayLimits.content)
    .refine((value) => !!value.trim(), '请粘贴卡片内容'),
});
const updateSchema = cardSchema
  .partial()
  .extend({ colorSlot: z.number().int().min(0).max(63).nullable().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, '请提供要修改的内容');
const idSchema = z.string().uuid();
const confirmSchema = z.object({ confirmed: z.literal(true) }).strict();
const attachmentSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(relayLimits.attachmentFilename)
    .refine(
      (name) =>
        !!name.trim() &&
        name !== '.' &&
        name !== '..' &&
        !/[\\/\u0000-\u001f\u007f-\u009f]/u.test(name) &&
        name === Buffer.from(name).toString(),
      '附件文件名无效',
    ),
  sizeBytes: z.number().int().min(0).max(relayLimits.attachmentBytes),
});
const offsetSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(relayLimits.attachmentBytes));
const uploadPath = '/relay/:id/attachments/:attachmentId/upload';
const attachmentPath = '/relay/:id/attachments/:attachmentId';
const rawChunk = raw({ limit: relayLimits.attachmentChunkBytes, inflate: false });

export function isAttachmentChunkRequest(method: string, path: string) {
  return method === 'PUT' && /^\/relay\/[^/]+\/attachments\/[^/]+\/upload\/?$/i.test(path);
}

export function createRelayFeature(dataDir: string) {
  return {
    name: 'relay',
    inject: ['db', 'http'],
    apply(ctx: Context) {
      const store = new RelayStore(ctx.db);
      const files = new RelayAttachmentFiles(dataDir, store);
      const router = Router();
      router.use('/relay', requireUser);
      router.get('/relay', (req, res) => {
        files.remove(store.prune());
        res.json(store.list(req.user!.id));
      });
      router.post('/relay', (req, res) => {
        const input = cardSchema
          .extend({ title: cardSchema.shape.title.default('') })
          .strict()
          .parse(req.body);
        res.status(201).json(store.create(req.user!.id, input));
      });
      router.get('/relay/:id', (req, res) => {
        res.json(store.get(req.user!.id, idSchema.parse(req.params.id)));
      });
      router.patch('/relay/:id', (req, res) => {
        res.json(
          store.update(req.user!.id, idSchema.parse(req.params.id), updateSchema.parse(req.body)),
        );
      });
      router.post('/relay/:id/persist', (req, res) => {
        confirmSchema.parse(req.body);
        res.json(store.persist(req.user!.id, idSchema.parse(req.params.id)));
      });
      router.delete('/relay/:id', (req, res) => {
        files.remove(store.delete(req.user!.id, idSchema.parse(req.params.id)));
        res.json({ ok: true });
      });
      router.post('/relay/attachments', (req, res) => {
        const { title, ...input } = attachmentSchema
          .extend({ title: cardSchema.shape.title.default('') })
          .strict()
          .parse(req.body);
        res.status(201).json(files.start(req.user!.id, randomUUID(), input, title));
      });
      router.post('/relay/:id/attachments', (req, res) => {
        const input = attachmentSchema.strict().parse(req.body);
        res.status(201).json(files.start(req.user!.id, idSchema.parse(req.params.id), input));
      });
      router.put(uploadPath, async (req, res) => {
        const length = req.get('content-length');
        if (length && Number(length) > relayLimits.attachmentChunkBytes)
          throw new HttpError(413, '上传分段超过大小限制');
        if ((req.get('content-encoding') ?? 'identity').toLowerCase() !== 'identity')
          throw new HttpError(415, '上传分段必须为未压缩的二进制数据');
        const progress = await files.writeChunk(
          req.user!.id,
          idSchema.parse(req.params.id),
          idSchema.parse(req.params.attachmentId),
          offsetSchema.parse(req.query.offset),
          async () => {
            await new Promise<void>((resolve, reject) => {
              rawChunk(req, res, (error) => (error ? reject(error) : resolve()));
            });
            return req.body ?? Buffer.alloc(0);
          },
        );
        res.json(progress);
      });
      router.delete(uploadPath, (req, res) => {
        files.cancel(
          req.user!.id,
          idSchema.parse(req.params.id),
          idSchema.parse(req.params.attachmentId),
        );
        res.json({ ok: true });
      });
      router.get(attachmentPath + '/download', (req, res, next) => {
        const attachment = store.getAttachment(
          req.user!.id,
          idSchema.parse(req.params.id),
          idSchema.parse(req.params.attachmentId),
        );
        res.download(
          files.path(attachment.id),
          attachment.filename,
          {
            cacheControl: false,
            lastModified: false,
            headers: {
              'Cache-Control': 'private, no-store',
              'Content-Type': 'application/octet-stream',
            },
          },
          (error) => {
            if (!error || res.destroyed) return;
            next(
              'code' in error && error.code === 'ENOENT'
                ? new HttpError(404, '附件不存在或已到期')
                : error,
            );
          },
        );
      });
      router.post(attachmentPath + '/persist', (req, res) => {
        confirmSchema.parse(req.body);
        res.json(
          store.persistAttachment(
            req.user!.id,
            idSchema.parse(req.params.id),
            idSchema.parse(req.params.attachmentId),
          ),
        );
      });
      router.delete(attachmentPath, (req, res) => {
        const id = store.deleteAttachment(
          req.user!.id,
          idSchema.parse(req.params.id),
          idSchema.parse(req.params.attachmentId),
        );
        files.remove([id]);
        res.json({ ok: true });
      });
      ctx.effect(() => {
        const prune = () => {
          files.remove(store.prune());
          files.reconcile();
        };
        prune();
        const timer = setInterval(() => {
          try {
            prune();
          } catch {
            console.warn('Relay cleanup failed');
          }
        }, 60_000);
        timer.unref();
        return () => {
          clearInterval(timer);
          files.dispose();
        };
      });
      ctx.effect(() => ctx.http.register(router));
    },
  };
}
