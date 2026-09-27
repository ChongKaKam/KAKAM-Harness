import { Service, type Context } from 'cordis';
import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkPassword, digest, hashPassword } from '../../kernel/crypto';
import { HttpError, requireUser } from '../../kernel/http';
import type { Config } from '../../server/config';
import type { User } from '../../shared/types';
import { manifest } from './manifest';
import { isRasterImage } from '../../shared/image-validation';
export { manifest };
export const emailSchema = z.string().trim().toLowerCase().email('请输入有效的邮箱地址').max(254);
export const passwordSchema = z.string().min(1, '请输入密码');
export const userColumns =
  'id,email,username AS legacyUsername,display_name AS displayName,avatar,role,active';
export const publicUser = (u: User): User => ({
  id: u.id,
  email: u.email,
  ...(!u.email ? { legacyUsername: u.legacyUsername } : {}),
  displayName: u.displayName,
  avatar: u.avatar ?? null,
  role: u.role,
  active: Boolean(u.active),
});
export class AuthService extends Service {
  static inject = ['db'];
  constructor(ctx: Context) {
    super(ctx, 'auth', true);
  }
  resolve(token?: string): User | undefined {
    if (!token) return;
    const row = this.ctx.db.get<User>(
      `SELECT u.id,u.email,u.username AS legacyUsername,u.display_name AS displayName,u.avatar,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`,
      digest(token),
      Date.now(),
    );
    return row ? publicUser(row) : undefined;
  }
}
export function authFeature(config: Config) {
  return {
    name: manifest.id,
    inject: ['db', 'http'],
    apply(ctx: Context) {
      ctx.plugin(AuthService);
      ctx.inject(['auth', 'db', 'http'], async (ctx) => {
        const router = Router();
        const limiter = rateLimit({
          windowMs: 15 * 60_000,
          limit: 30,
          standardHeaders: 'draft-8',
          legacyHeaders: false,
          message: { error: '尝试过于频繁，请稍后再试' },
        });
        const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
        function session(res: Response, user: User) {
          const token = randomBytes(32).toString('hex');
          const age = 7 * 24 * 60 * 60_000;
          ctx.db.run('DELETE FROM sessions WHERE expires_at<?', Date.now());
          ctx.db.run(
            'INSERT INTO sessions VALUES(?,?,?)',
            digest(token),
            user.id,
            Date.now() + age,
          );
          res.cookie('kh_session', token, {
            httpOnly: true,
            sameSite: 'strict',
            secure: config.secureCookies,
            maxAge: age,
            path: '/',
          });
          res.json({ user: publicUser(user) });
        }
        router.get('/auth/status', (_req, res) => {
          res.json({
            needsSetup: !ctx.db.get('SELECT id FROM users LIMIT 1'),
            registrationEnabled: true,
          });
        });
        router.post('/auth/register', limiter, async (req, res) => {
          const input = z
            .object({
              email: emailSchema,
              displayName: z.string().trim().min(1).max(60),
              password: passwordSchema,
            })
            .parse(req.body);
          const hash = await hashPassword(input.password);
          const user = ctx.db.transaction(() => {
            if (ctx.db.get('SELECT id FROM users WHERE email=?', input.email))
              throw new HttpError(409, '邮箱已被使用');
            // Role selection and insert share the same write transaction, including concurrent first registrations.
            const role = ctx.db.get('SELECT id FROM users LIMIT 1') ? 'user' : 'admin';
            const user: User = {
              id: randomUUID(),
              email: input.email,
              displayName: input.displayName,
              avatar: null,
              role,
              active: true,
            };
            ctx.db.run(
              'INSERT INTO users(id,username,display_name,password_hash,role,email) VALUES(?,?,?,?,?,?)',
              user.id,
              user.id,
              user.displayName,
              hash,
              role,
              user.email,
            );
            return user;
          });
          res.status(201);
          session(res, user);
        });
        router.post('/auth/login', limiter, async (req, res) => {
          const input = z.object({ email: emailSchema, password: passwordSchema }).parse(req.body);
          const user = ctx.db.get<User & { passwordHash: string }>(
            `SELECT ${userColumns}, password_hash AS passwordHash FROM users WHERE email=?`,
            input.email,
          );
          const valid = await checkPassword(input.password, user?.passwordHash ?? dummyHash);
          if (!user || !valid || !user.active) throw new HttpError(401, '邮箱或密码不正确');
          session(res, user);
        });
        router.post('/auth/migrate-email', limiter, async (req, res) => {
          const input = z
            .object({
              legacyUsername: z.string().min(1).max(40),
              email: emailSchema,
              password: passwordSchema,
            })
            .parse(req.body);
          const user = ctx.db.get<User & { passwordHash: string }>(
            `SELECT ${userColumns},password_hash AS passwordHash FROM users WHERE username=? AND email IS NULL`,
            input.legacyUsername,
          );
          const valid = await checkPassword(input.password, user?.passwordHash ?? dummyHash);
          if (!user || !valid || !user.active)
            throw new HttpError(401, '旧账户或密码不正确，或该账户已绑定邮箱');
          ctx.db.transaction(() => {
            if (ctx.db.get('SELECT id FROM users WHERE email=?', input.email))
              throw new HttpError(409, '邮箱已被使用');
            const updated = ctx.db.run(
              'UPDATE users SET email=? WHERE id=? AND email IS NULL AND password_hash=? AND active=1',
              input.email,
              user.id,
              user.passwordHash,
            );
            if (!updated.changes) throw new HttpError(409, '账户状态已更新，请重新登录');
            ctx.db.run('DELETE FROM sessions WHERE user_id=?', user.id);
          });
          session(res, { ...user, email: input.email });
        });
        router.get('/auth/me', requireUser, (req, res) => res.json({ user: req.user }));
        router.patch('/auth/avatar', requireUser, (req, res) => {
          const { avatar } = z
            .object({
              avatar: z
                .string()
                .max(700_000)
                .refine(
                  (data) => isRasterImage(data, 512 * 1024),
                  '头像需为 512 KB 以内的 PNG、JPEG 或 WebP 图片',
                )
                .nullable(),
            })
            .strict()
            .parse(req.body);
          ctx.db.run('UPDATE users SET avatar=? WHERE id=?', avatar, req.user!.id);
          res.json({ user: publicUser({ ...req.user!, avatar }) });
        });
        router.post('/auth/logout', requireUser, (req, res) => {
          ctx.db.run('DELETE FROM sessions WHERE token_hash=?', digest(req.cookies.kh_session));
          res.clearCookie('kh_session', {
            path: '/',
            httpOnly: true,
            sameSite: 'strict',
            secure: config.secureCookies,
          });
          res.json({ ok: true });
        });
        router.patch('/auth/me', requireUser, limiter, async (req, res) => {
          const input = z
            .object({
              displayName: z.string().trim().min(1).max(60),
              email: emailSchema.optional(),
              currentPassword: z.string().optional(),
              newPassword: passwordSchema.optional(),
            })
            .parse(req.body);
          const changingEmail = input.email !== undefined && input.email !== req.user!.email;
          let hash: string | undefined;
          if (input.newPassword || changingEmail) {
            const row = ctx.db.get<{ hash: string }>(
              'SELECT password_hash AS hash FROM users WHERE id=?',
              req.user!.id,
            )!;
            if (!input.currentPassword || !(await checkPassword(input.currentPassword, row.hash)))
              throw new HttpError(400, '当前密码不正确');
            if (input.newPassword) hash = await hashPassword(input.newPassword);
          }
          ctx.db.transaction(() => {
            if (
              changingEmail &&
              ctx.db.get('SELECT id FROM users WHERE email=? AND id<>?', input.email!, req.user!.id)
            )
              throw new HttpError(409, '邮箱已被使用');
            ctx.db.run(
              'UPDATE users SET display_name=?,email=? WHERE id=?',
              input.displayName,
              input.email ?? req.user!.email,
              req.user!.id,
            );
            if (hash) ctx.db.run('UPDATE users SET password_hash=? WHERE id=?', hash, req.user!.id);
            if (hash || changingEmail)
              ctx.db.run(
                'DELETE FROM sessions WHERE user_id=? AND token_hash<>?',
                req.user!.id,
                digest(req.cookies.kh_session),
              );
          });
          res.json({
            user: publicUser({
              ...req.user!,
              email: input.email ?? req.user!.email,
              displayName: input.displayName,
            }),
          });
        });
        ctx.effect(() => ctx.http.register(router));
      });
    },
  };
}
