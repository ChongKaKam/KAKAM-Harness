import { Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { requireUser } from '../../kernel/http';
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

export const server = {
  name: 'relay',
  inject: ['db', 'http'],
  apply(ctx: Context) {
    const store = new RelayStore(ctx.db);
    const router = Router();
    router.use('/relay', requireUser);
    router.get('/relay', (req, res) => res.json(store.list(req.user!.id)));
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
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(req.body);
      res.json(store.persist(req.user!.id, idSchema.parse(req.params.id)));
    });
    router.delete('/relay/:id', (req, res) => {
      store.delete(req.user!.id, idSchema.parse(req.params.id));
      res.json({ ok: true });
    });
    ctx.effect(() => {
      store.prune();
      const timer = setInterval(() => store.prune(), 60_000);
      timer.unref();
      return () => clearInterval(timer);
    });
    ctx.effect(() => ctx.http.register(router));
  },
};
