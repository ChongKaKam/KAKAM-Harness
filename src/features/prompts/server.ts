import { Router } from 'express';
import type { Context } from 'cordis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
export { manifest } from './manifest';
export const server = {
  name: 'prompts',
  inject: ['db', 'http'],
  apply(ctx: Context) {
    const router = Router();
    router.use('/prompts', requireUser);
    router.get('/prompts', (req, res) =>
      res.json(
        ctx.db.all(
          'SELECT id,title,content,color_slot AS colorSlot FROM prompts WHERE user_id=? ORDER BY rowid DESC',
          req.user!.id,
        ),
      ),
    );
    router.post('/prompts', (req, res) => {
      const input = z
        .object({
          title: z.string().trim().min(1).max(80),
          content: z.string().trim().min(1).max(20_000),
        })
        .parse(req.body);
      const id = randomUUID();
      ctx.db.run(
        'INSERT INTO prompts(id,user_id,title,content) VALUES(?,?,?,?)',
        id,
        req.user!.id,
        input.title,
        input.content,
      );
      res.status(201).json({ id });
    });
    router.patch('/prompts/:id/color', (req, res) => {
      const { colorSlot } = z
        .object({ colorSlot: z.number().int().min(0).max(63).nullable() })
        .parse(req.body);
      const result = ctx.db.run(
        'UPDATE prompts SET color_slot=? WHERE id=? AND user_id=?',
        colorSlot,
        String(req.params.id),
        req.user!.id,
      );
      if (!result.changes) throw new HttpError(404, '提示词不存在');
      res.json({ ok: true });
    });
    router.delete('/prompts/:id', (req, res) => {
      ctx.db.run(
        'DELETE FROM prompts WHERE id=? AND user_id=?',
        String(req.params.id),
        req.user!.id,
      );
      res.json({ ok: true });
    });
    ctx.effect(() => ctx.http.register(router));
  },
};
