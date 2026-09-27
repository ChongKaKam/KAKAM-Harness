import { Router } from 'express';
import type { Context } from 'cordis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireAdmin } from '../../kernel/http';
import { hashPassword } from '../../kernel/crypto';
import { passwordSchema, emailSchema, userColumns, publicUser } from '../auth/server';
import type { User } from '../../shared/types';
export { manifest } from './manifest';
export const server = {
  name: 'users',
  inject: ['db', 'http', 'auth'],
  apply(ctx: Context) {
    const router = Router();
    router.use('/admin/users', requireAdmin);
    router.get('/admin/users', (_req, res) =>
      res.json(
        ctx.db.all<User>(`SELECT ${userColumns} FROM users ORDER BY created_at`).map(publicUser),
      ),
    );
    router.post('/admin/users', async (req, res) => {
      const input = z
        .object({
          email: emailSchema,
          displayName: z.string().trim().min(1).max(60),
          password: passwordSchema,
          role: z.enum(['admin', 'user']),
        })
        .parse(req.body);
      const hash = await hashPassword(input.password);
      const id = randomUUID();
      if (ctx.db.get('SELECT id FROM users WHERE email=?', input.email))
        throw new HttpError(409, '邮箱已被使用');
      ctx.db.run(
        'INSERT INTO users(id,username,display_name,password_hash,role,email) VALUES(?,?,?,?,?,?)',
        id,
        id,
        input.displayName,
        hash,
        input.role,
        input.email,
      );
      res.status(201).json({ id });
    });
    router.patch('/admin/users/:id', async (req, res) => {
      const input = z
        .object({
          role: z.enum(['admin', 'user']).optional(),
          active: z.boolean().optional(),
          displayName: z.string().trim().min(1).max(60).optional(),
          email: emailSchema.optional(),
          password: passwordSchema.optional(),
        })
        .parse(req.body);
      const id = String(req.params.id);
      const hash = input.password ? await hashPassword(input.password) : undefined;
      ctx.db.transaction(() => {
        const user = ctx.db.get<User>(`SELECT ${userColumns} FROM users WHERE id=?`, id);
        if (!user) throw new HttpError(404, '用户不存在');
        if (
          input.email &&
          ctx.db.get('SELECT id FROM users WHERE email=? AND id<>?', input.email, id)
        )
          throw new HttpError(409, '邮箱已被使用');
        if (user.id === req.user!.id && (input.active === false || input.role === 'user'))
          throw new HttpError(400, '不能停用或降级当前管理员');
        if (
          user.role === 'admin' &&
          user.active &&
          (input.role === 'user' || input.active === false)
        ) {
          const count = ctx.db.get<{ count: number }>(
            "SELECT count(*) AS count FROM users WHERE role='admin' AND active=1",
          )!.count;
          if (count <= 1) throw new HttpError(400, '至少保留一位有效管理员');
        }
        ctx.db.run(
          'UPDATE users SET role=?, active=?, display_name=?,email=? WHERE id=?',
          input.role ?? user.role,
          Number(input.active ?? Boolean(user.active)),
          input.displayName ?? user.displayName,
          input.email ?? user.email,
          id,
        );
        if (hash) ctx.db.run('UPDATE users SET password_hash=? WHERE id=?', hash, id);
        if (
          hash ||
          input.active === false ||
          input.role ||
          (input.email && input.email !== user.email)
        )
          ctx.db.run('DELETE FROM sessions WHERE user_id=?', id);
      });
      res.json({ ok: true });
    });
    ctx.effect(() => ctx.http.register(router));
  },
};
