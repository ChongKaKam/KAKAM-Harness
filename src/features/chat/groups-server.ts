import { randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import type { Router } from 'express';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
import { isGroupSymbol } from './groups';

const fields = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().max(32).refine(isGroupSymbol, '请选择图标或输入一个 emoji'),
  colorSlot: z.number().int().min(0).max(63).nullable(),
});

export function ownGroup(ctx: Context, id: string, userId: string) {
  if (!ctx.db.get('SELECT id FROM conversation_groups WHERE id=? AND user_id=?', id, userId))
    throw new HttpError(404, '分组不存在');
}

export function registerGroupRoutes(ctx: Context, router: Router) {
  router.use('/conversation-groups', requireUser);
  router.get('/conversation-groups', (req, res) => {
    res.json(
      ctx.db.all(
        'SELECT id,name,icon,color_slot AS colorSlot FROM conversation_groups WHERE user_id=? ORDER BY created_at,id',
        req.user!.id,
      ),
    );
  });
  router.post('/conversation-groups', (req, res) => {
    const input = fields
      .extend({
        icon: fields.shape.icon.default('folder'),
        colorSlot: fields.shape.colorSlot.default(null),
      })
      .parse(req.body);
    const id = randomUUID();
    ctx.db.run(
      'INSERT INTO conversation_groups(id,user_id,name,icon,color_slot,created_at) VALUES(?,?,?,?,?,?)',
      id,
      req.user!.id,
      input.name,
      input.icon,
      input.colorSlot,
      new Date().toISOString(),
    );
    res.status(201).json({ id, ...input });
  });
  router.patch('/conversation-groups/:id', (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const userId = req.user!.id;
    ownGroup(ctx, id, userId);
    const input = fields
      .partial()
      .refine((value) => Object.keys(value).length > 0)
      .parse(req.body);
    ctx.db.transaction(() => {
      if (input.name !== undefined)
        ctx.db.run(
          'UPDATE conversation_groups SET name=? WHERE id=? AND user_id=?',
          input.name,
          id,
          userId,
        );
      if (input.icon !== undefined)
        ctx.db.run(
          'UPDATE conversation_groups SET icon=? WHERE id=? AND user_id=?',
          input.icon,
          id,
          userId,
        );
      if (input.colorSlot !== undefined)
        ctx.db.run(
          'UPDATE conversation_groups SET color_slot=? WHERE id=? AND user_id=?',
          input.colorSlot,
          id,
          userId,
        );
    });
    res.json({ ok: true });
  });
  router.delete('/conversation-groups/:id', async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    ownGroup(ctx, id, req.user!.id);
    // ON DELETE SET NULL preserves the conversations and any active generation.
    ctx.db.run('DELETE FROM conversation_groups WHERE id=? AND user_id=?', id, req.user!.id);
    await ctx.extensions.removeMemoryScope(req.user!, 'group', id);
    res.json({ ok: true });
  });
}
