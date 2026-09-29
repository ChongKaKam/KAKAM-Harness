import { Service, type Context } from 'cordis';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError, requireUser, requireAdmin } from '../../kernel/http';
import { SecretVault } from '../../kernel/crypto';
import { testModelConnection } from './connection-test';
import type { Model, User, ApiMode } from '../../shared/types';
export { manifest } from './manifest';
const columns = `m.id,m.provider_id AS providerId,p.name AS providerName,m.name,m.label,m.vision,m.enabled,CASE WHEN p.api_mode='jev' THEN 'jev' ELSE 'llm' END AS kind`;
const normalize = (m: Model) => ({
  ...m,
  vision: m.kind !== 'jev' && Boolean(m.vision),
  enabled: Boolean(m.enabled),
});
export const baseUrl = z.url().refine((v) => {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (
    ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash
  );
}, '请输入完整的 HTTP(S) API 地址，不含凭据、查询或片段');
const platformUrl = z
  .union([
    z.literal(''),
    z
      .url()
      .max(2048)
      .refine((value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return false;
        }
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
      }, '请输入不含用户名或密码的 HTTP(S) 平台链接'),
  ])
  .nullable()
  .transform((value) => value || null)
  .optional();
const providerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl,
  platformUrl,
  apiMode: z
    .enum(['chat-completions', 'responses', 'anthropic-messages', 'jev'])
    .default('chat-completions'),
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
        `SELECT ${columns} FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.enabled=1 ${user.role === 'admin' ? '' : 'AND EXISTS(SELECT 1 FROM model_grants g WHERE g.model_id=m.id AND g.user_id=?)'} ORDER BY m.sort_order,m.id`,
        ...(user.role === 'admin' ? [] : [user.id]),
      )
      .map(normalize);
  }
  authorize(user: User, id: string, kind?: Model['kind']) {
    const model = this.list(user).find((m) => m.id === id);
    if (!model) throw new HttpError(403, '模型未启用或未向你授权');
    if (kind && model.kind !== kind)
      throw new HttpError(400, kind === 'llm' ? '请选择 LLM 模型' : '请选择 Jev 决策模型');
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
  decrypt(value: string) {
    return this.vault.decrypt(value);
  }
  encrypt(value: string) {
    return this.vault.encrypt(value);
  }
  adapter(mode: ApiMode = 'chat-completions') {
    return this.ctx.adapters.get(
      mode === 'jev'
        ? 'jev'
        : mode === 'anthropic-messages'
          ? 'anthropic-messages'
          : 'openai-compatible',
    );
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
        router.get('/models', requireUser, (req, res) => {
          const { kind } = z
            .object({ kind: z.enum(['llm', 'jev', 'all']).default('llm') })
            .parse(req.query);
          res.json(
            ctx.models.list(req.user!).filter((model) => kind === 'all' || model.kind === kind),
          );
        });
        router.use('/admin/providers', requireAdmin);
        router.use('/admin/models', requireAdmin);
        router.get('/admin/providers', (_req, res) =>
          res.json(
            ctx.db
              .all<{ id: string; name: string; baseUrl: string }>(
                'SELECT id,name,base_url AS baseUrl,api_mode AS apiMode,platform_url AS platformUrl FROM providers',
              )
              .map((p) => ({ ...p, hasKey: !!ctx.models.connection(p.id).apiKey })),
          ),
        );
        router.post('/admin/providers', (req, res) => {
          const input = providerSchema.parse(req.body);
          const id = randomUUID();
          ctx.db.run(
            'INSERT INTO providers(id,name,base_url,encrypted_key,api_mode,platform_url) VALUES(?,?,?,?,?,?)',
            id,
            input.name,
            input.baseUrl.replace(/\/+$/, ''),
            ctx.models.encrypt(input.apiKey),
            input.apiMode,
            input.platformUrl ?? null,
          );
          res.status(201).json({ id });
        });
        router.post('/admin/providers/discover', async (req, res) => {
          const input = providerSchema
            .omit({ name: true, apiKey: true, platformUrl: true })
            .extend({ id: z.string().uuid().optional(), apiKey: z.string().max(4096).optional() })
            .parse(req.body);
          const saved = input.id ? ctx.models.connection(input.id) : undefined;
          const connection = {
            baseUrl: input.baseUrl,
            apiMode: input.apiMode,
            apiKey: input.apiKey ?? saved?.apiKey ?? '',
          };
          res.json({ models: await ctx.models.adapter(connection.apiMode).discover(connection) });
        });
        router.post('/admin/models/:id/test', async (req, res) => {
          const { reasoningEffort } = z
            .object({
              reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']).default('none'),
            })
            .strict()
            .parse(req.body ?? {});
          // Administrators may test a disabled model before making it available to users.
          const model = ctx.db.get<Model>(
            'SELECT id,provider_id AS providerId,name FROM models WHERE id=?',
            String(req.params.id),
          );
          if (!model) throw new HttpError(404, '模型不存在');
          const connection = ctx.models.connection(model.providerId);
          const result = await testModelConnection(
            ctx.models.adapter(connection.apiMode),
            connection,
            model.name,
            reasoningEffort,
          );
          ctx.db.run(
            'INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)',
            randomUUID(),
            req.user!.id,
            `[连接测试] ${model.name}`,
            result.usage?.input ?? null,
            result.usage?.output ?? null,
            result.usage?.total ?? null,
            result.ok ? 'complete' : 'error',
            new Date().toISOString(),
          );
          res.json(result);
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
          if (input.platformUrl !== undefined)
            ctx.db.run('UPDATE providers SET platform_url=? WHERE id=?', input.platformUrl, id);
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
        router.post('/admin/providers/:id/discover', async (req, res) => {
          const connection = ctx.models.connection(String(req.params.id));
          res.json({ models: await ctx.models.adapter(connection.apiMode).discover(connection) });
        });
        router.get('/admin/models', (_req, res) =>
          res.json(
            ctx.db
              .all<Model>(
                `SELECT ${columns} FROM models m JOIN providers p ON p.id=m.provider_id ORDER BY m.sort_order,m.id`,
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
            'INSERT INTO models(id,provider_id,name,label,vision,sort_order) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM models))',
            id,
            input.providerId,
            input.name,
            input.label,
            Number(input.vision && ctx.models.connection(input.providerId).apiMode !== 'jev'),
          );
          res.status(201).json({ id });
        });
        router.patch('/admin/models/order', (req, res) => {
          const { modelIds } = z
            .object({ modelIds: z.array(z.string().uuid()).max(10000) })
            .parse(req.body);
          ctx.db.transaction(() => {
            const existing = ctx.db.all<{ id: string }>('SELECT id FROM models');
            const ids = new Set(modelIds);
            if (ids.size !== modelIds.length) throw new HttpError(400, '模型排序包含重复项');
            if (existing.length !== ids.size || existing.some((m) => !ids.has(m.id)))
              throw new HttpError(409, '模型列表已变化，请刷新后重新排序');
            modelIds.forEach((id, index) =>
              ctx.db.run('UPDATE models SET sort_order=? WHERE id=?', index, id),
            );
          });
          res.json({ ok: true });
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
          const savedModel = ctx.db.get<{ providerId: string }>(
            'SELECT provider_id AS providerId FROM models WHERE id=?',
            id,
          );
          if (!savedModel) throw new HttpError(404, '模型不存在');
          ctx.db.transaction(() => {
            for (const userId of input.userIds)
              if (!ctx.db.get('SELECT id FROM users WHERE id=?', userId))
                throw new HttpError(400, '授权用户不存在');
            ctx.db.run(
              'UPDATE models SET enabled=?,vision=?,label=? WHERE id=?',
              Number(input.enabled),
              Number(
                input.vision && ctx.models.connection(savedModel.providerId).apiMode !== 'jev',
              ),
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
