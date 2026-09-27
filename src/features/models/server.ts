import { Service, type Context } from 'cordis';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireUser, requireAdmin } from '../../kernel/http';
import { SecretVault } from '../../kernel/crypto';
import type { Model, User, ApiMode } from '../../shared/types';
export { manifest } from './manifest';
const columns =
  'm.id,m.provider_id AS providerId,p.name AS providerName,m.name,m.label,m.vision,m.enabled';
const normalize = (m: Model) => ({ ...m, vision: Boolean(m.vision), enabled: Boolean(m.enabled) });
const baseUrl = z.url().refine((v) => {
  const u = new URL(v);
  return (
    ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash
  );
}, '请输入完整的 HTTP(S) API 地址，不含凭据、查询或片段');
const providerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl,
  apiMode: z.enum(['chat-completions', 'responses']).default('chat-completions'),
  apiKey: z.string().max(4096).default(''),
});
const modelSchema = z.object({
  providerId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(100),
  vision: z.boolean().default(false),
});
export class ModelsService extends Service {
  static inject = ['db', 'adapters'];
  private vault: SecretVault;
  constructor(ctx: Context, secret: string) {
    super(ctx, 'models', true);
    this.vault = new SecretVault(secret);
  }
  list(user: User): Model[] {
    return this.ctx.db
      .all<Model>(
        `SELECT ${columns} FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.enabled=1 ${user.role === 'admin' ? '' : 'AND EXISTS(SELECT 1 FROM model_grants g WHERE g.model_id=m.id AND g.user_id=?)'} ORDER BY p.name,m.label`,
        ...(user.role === 'admin' ? [] : [user.id]),
      )
      .map(normalize);
  }
  authorize(user: User, id: string) {
    const model = this.list(user).find((m) => m.id === id);
    if (!model) throw new HttpError(403, '模型未启用或未向你授权');
    return model;
  }
  connection(id: string) {
    const p = this.ctx.db.get<{ baseUrl: string; key: string; apiMode: ApiMode }>(
      'SELECT base_url AS baseUrl,encrypted_key AS key,api_mode AS apiMode FROM providers WHERE id=?',
      id,
    );
    if (!p) throw new HttpError(404, '模型来源不存在');
    return { baseUrl: p.baseUrl, apiKey: this.vault.decrypt(p.key), apiMode: p.apiMode };
  }
  encrypt(value: string) {
    return this.vault.encrypt(value);
  }
  adapter() {
    return this.ctx.adapters.get('openai-compatible');
  }
}
export function modelsFeature(secret: string) {
  return {
    name: 'models',
    inject: ['db', 'http', 'adapters'],
    apply(ctx: Context) {
      ctx.plugin(ModelsService, secret);
      ctx.inject(['models', 'db', 'http'], (ctx) => {
        const router = Router();
        router.get('/models', requireUser, (req, res) => res.json(ctx.models.list(req.user!)));
        router.use('/admin/providers', requireAdmin);
        router.use('/admin/models', requireAdmin);
        router.get('/admin/providers', (_req, res) =>
          res.json(
            ctx.db
              .all<{ id: string; name: string; baseUrl: string }>(
                'SELECT id,name,base_url AS baseUrl,api_mode AS apiMode FROM providers',
              )
              .map((p) => ({ ...p, hasKey: !!ctx.models.connection(p.id).apiKey })),
          ),
        );
        router.post('/admin/providers', (req, res) => {
          const input = providerSchema.parse(req.body);
          const id = randomUUID();
          ctx.db.run(
            'INSERT INTO providers(id,name,base_url,encrypted_key,api_mode) VALUES(?,?,?,?,?)',
            id,
            input.name,
            input.baseUrl.replace(/\/+$/, ''),
            ctx.models.encrypt(input.apiKey),
            input.apiMode,
          );
          res.status(201).json({ id });
        });
        router.post('/admin/providers/test', async (req, res) => {
          const input = providerSchema
            .omit({ name: true, apiKey: true })
            .extend({
              id: z.string().uuid().optional(),
              apiKey: z.string().max(4096).optional(),
              model: z.string().trim().min(1).max(200),
            })
            .parse(req.body);
          const saved = input.id ? ctx.models.connection(input.id) : undefined;
          const connection = {
            baseUrl: input.baseUrl,
            apiMode: input.apiMode,
            apiKey: input.apiKey ?? saved?.apiKey ?? '',
          };
          const started = Date.now();
          const id = randomUUID();
          let usage: { input: number; output: number; total: number } | undefined;
          let status = 'error';
          try {
            for await (const chunk of ctx.models
              .adapter()
              .generate(
                connection,
                input.model,
                [{ role: 'user', content: 'Reply with only OK.' }],
                AbortSignal.timeout(20_000),
              )) {
              if (chunk.type === 'usage') usage = chunk.usage;
            }
            status = 'complete';
            res.json({
              ok: true,
              latencyMs: Date.now() - started,
              apiMode: input.apiMode,
              model: input.model,
            });
          } catch (error) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(502, '连接测试失败或超时，请检查地址、密钥、模型及响应模式');
          } finally {
            ctx.db.run(
              'INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)',
              id,
              req.user!.id,
              `[连接测试] ${input.model}`,
              usage?.input ?? null,
              usage?.output ?? null,
              usage?.total ?? null,
              status,
              new Date().toISOString(),
            );
          }
        });
        router.patch('/admin/providers/:id', (req, res) => {
          const input = providerSchema
            .omit({ apiKey: true })
            .extend({ apiKey: z.string().max(4096).optional() })
            .parse(req.body);
          const id = String(req.params.id);
          ctx.models.connection(id);
          ctx.db.run(
            'UPDATE providers SET name=?,base_url=?,api_mode=? WHERE id=?',
            input.name,
            input.baseUrl.replace(/\/+$/, ''),
            input.apiMode,
            id,
          );
          if (input.apiKey !== undefined)
            ctx.db.run(
              'UPDATE providers SET encrypted_key=? WHERE id=?',
              ctx.models.encrypt(input.apiKey),
              id,
            );
          res.json({ ok: true });
        });
        router.delete('/admin/providers/:id', (req, res) => {
          ctx.db.run('DELETE FROM providers WHERE id=?', String(req.params.id));
          res.json({ ok: true });
        });
        router.post('/admin/providers/:id/discover', async (req, res) =>
          res.json({
            models: await ctx.models
              .adapter()
              .discover(ctx.models.connection(String(req.params.id))),
          }),
        );
        router.get('/admin/models', (_req, res) =>
          res.json(
            ctx.db
              .all<Model>(
                `SELECT ${columns} FROM models m JOIN providers p ON p.id=m.provider_id ORDER BY p.name,m.label`,
              )
              .map((m) => ({
                ...normalize(m),
                userIds: ctx.db
                  .all<{ id: string }>(
                    'SELECT user_id AS id FROM model_grants WHERE model_id=?',
                    m.id,
                  )
                  .map((g) => g.id),
              })),
          ),
        );
        router.post('/admin/models', (req, res) => {
          const input = modelSchema.parse(req.body);
          ctx.models.connection(input.providerId);
          if (
            ctx.db.get(
              'SELECT id FROM models WHERE provider_id=? AND name=?',
              input.providerId,
              input.name,
            )
          )
            throw new HttpError(409, '此模型已在白名单中');
          const id = randomUUID();
          ctx.db.run(
            'INSERT INTO models(id,provider_id,name,label,vision) VALUES(?,?,?,?,?)',
            id,
            input.providerId,
            input.name,
            input.label,
            Number(input.vision),
          );
          res.status(201).json({ id });
        });
        router.patch('/admin/models/:id', (req, res) => {
          const input = z
            .object({
              enabled: z.boolean(),
              vision: z.boolean(),
              label: z.string().trim().min(1).max(100),
              userIds: z.array(z.string().uuid()).max(1000),
            })
            .parse(req.body);
          const id = String(req.params.id);
          if (!ctx.db.get('SELECT id FROM models WHERE id=?', id))
            throw new HttpError(404, '模型不存在');
          ctx.db.transaction(() => {
            for (const userId of input.userIds)
              if (!ctx.db.get('SELECT id FROM users WHERE id=?', userId))
                throw new HttpError(400, '授权用户不存在');
            ctx.db.run(
              'UPDATE models SET enabled=?,vision=?,label=? WHERE id=?',
              Number(input.enabled),
              Number(input.vision),
              input.label,
              id,
            );
            ctx.db.run('DELETE FROM model_grants WHERE model_id=?', id);
            for (const userId of new Set(input.userIds))
              ctx.db.run('INSERT INTO model_grants VALUES(?,?)', id, userId);
          });
          res.json({ ok: true });
        });
        router.delete('/admin/models/:id', (req, res) => {
          ctx.db.run('DELETE FROM models WHERE id=?', String(req.params.id));
          res.json({ ok: true });
        });
        ctx.effect(() => ctx.http.register(router));
      });
    },
  };
}
