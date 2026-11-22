import { Service, type Context } from 'cordis';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { HttpError, requireUser, requireAdmin } from '../../kernel/http';
import { SecretVault } from '../../kernel/crypto';
import {
  testModelConnection,
  testEmbeddingConnection,
  testToolConnection,
} from './connection-test';
import { EmbeddingError, validateEmbeddingResponse } from '../../adapters/embeddings';
import { ImageGenerationError, imageMimeType } from '../../adapters/images';
import type { ImageGenerationResult } from '../../adapters/registry';
import { nextSourceProbeDelay } from './probe-schedule';
import type { Model, User, ApiMode, EmbeddingResult, EmbeddingUsage } from '../../shared/types';
export { manifest } from './manifest';
const selectModels = `SELECT m.id,m.provider_id AS providerId,p.name AS providerName,m.name,m.label,
  m.vision,m.tool_calling AS toolCalling,m.enabled,m.needs_protocol_review AS needsProtocolReview,m.kind,m.context_window_tokens AS contextWindowTokens,
  m.max_output_tokens AS maxOutputTokens,m.embedding_dimensions AS embeddingDimensions,
  m.validated_dimensions AS validatedDimensions FROM models m JOIN providers p ON p.id=m.provider_id`;
// A running conversation may outlive an account or role change.
const selectVisibleModels = `${selectModels} JOIN users u ON u.id=? AND u.active=1
  WHERE m.enabled=1 AND (u.role='admin' OR EXISTS(
    SELECT 1 FROM model_grants g WHERE g.model_id=m.id AND g.user_id=u.id
  ))`;
const normalize = (m: Model) => ({
  ...m,
  vision: m.kind === 'llm' && Boolean(m.vision),
  toolCalling: m.kind === 'llm' && Boolean(m.toolCalling),
  enabled: Boolean(m.enabled),
  needsProtocolReview: Boolean(m.needsProtocolReview),
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
const sourceProtocol = z.enum(['responses', 'anthropic-messages', 'jev']);
const providerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  baseUrl,
  platformUrl,
  apiMode: sourceProtocol.default('responses'),
  apiKey: z.string().max(4096).default(''),
});
const tokenLimitsSchema = z.object({
  contextWindowTokens: z.int().min(2).nullable().optional(),
  maxOutputTokens: z.int().positive().nullable().optional(),
});
const modelSchema = z.object({
  ...tokenLimitsSchema.shape,
  providerId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(100),
  vision: z.boolean().default(false),
  toolCalling: z.boolean().default(false),
  kind: z.enum(['llm', 'jev', 'embedding', 'image']).optional(),
  embeddingDimensions: z.number().int().min(1).max(16000).nullable().default(null),
});
function modelTokenLimits(
  kind: Model['kind'],
  input: z.infer<typeof tokenLimitsSchema>,
  saved: z.infer<typeof tokenLimitsSchema> = {},
) {
  if (kind !== 'llm') {
    if (input.contextWindowTokens != null || input.maxOutputTokens != null)
      throw new HttpError(400, '仅对话模型可以设置上下文窗口和最大输出');
    return { contextWindowTokens: null, maxOutputTokens: null };
  }
  const {
    contextWindowTokens = saved.contextWindowTokens ?? null,
    maxOutputTokens = saved.maxOutputTokens ?? null,
  } = input;
  if (
    contextWindowTokens !== null &&
    maxOutputTokens !== null &&
    maxOutputTokens >= contextWindowTokens
  )
    throw new HttpError(400, '最大输出 Token 数必须小于上下文窗口');
  return { contextWindowTokens, maxOutputTokens };
}
const embeddingInputs = z
  .array(z.string().min(1).max(100_000))
  .min(1)
  .max(128)
  .refine((inputs) => inputs.every((input) => input.trim().length > 0), 'Embedding 输入不能为空')
  .refine(
    (inputs) => inputs.reduce((total, input) => total + input.length, 0) <= 512_000,
    'Embedding 输入总长度超过限制',
  );
function validateKind(mode: ApiMode, kind: Model['kind']) {
  if (kind === 'embedding' && mode !== 'responses')
    throw new HttpError(400, 'Embedding 仅支持 OpenAI-compatible 来源，Anthropic / Jev 不支持');
  if (kind === 'image' && mode !== 'responses')
    throw new HttpError(400, '图片生成仅支持 OpenAI-compatible 来源，Anthropic / Jev 不支持');
  if ((kind === 'jev') !== (mode === 'jev'))
    throw new HttpError(400, 'Jev 模型必须使用 Jev 来源协议');
}
export class ModelsService extends Service {
  static inject = ['db', 'adapters'];
  private vault: SecretVault;
  constructor(ctx: Context, secret: string) {
    super(ctx, 'models', true);
    this.vault = new SecretVault(secret);
  }
  list(user: User): Model[] {
    return this.ctx.db
      .all<Model>(`${selectVisibleModels} ORDER BY m.sort_order,m.id`, user.id)
      .map(normalize);
  }
  authorize(user: User, id: string, kind?: Model['kind']) {
    const model = this.ctx.db.get<Model>(`${selectVisibleModels} AND m.id=?`, user.id, id);
    if (!model) throw new HttpError(403, '模型未启用或未向你授权');
    if (kind && model.kind !== kind)
      throw new HttpError(
        400,
        kind === 'llm'
          ? '请选择 LLM 模型'
          : kind === 'embedding'
            ? '请选择 Embedding 模型'
            : kind === 'image'
              ? '请选择图片生成模型'
              : '请选择 Jev 决策模型',
      );
    return normalize(model);
  }
  connection(
    source: string | Pick<Model, 'providerId' | 'contextWindowTokens' | 'maxOutputTokens'>,
  ) {
    const p = this.ctx.db.get<{ baseUrl: string; key: string; apiMode: ApiMode }>(
      'SELECT base_url AS baseUrl,encrypted_key AS key,api_mode AS apiMode FROM providers WHERE id=?',
      typeof source === 'string' ? source : source.providerId,
    );
    if (!p) throw new HttpError(404, '模型来源不存在');
    return {
      baseUrl: p.baseUrl,
      apiKey: this.vault.decrypt(p.key),
      apiMode: p.apiMode,
      ...(typeof source === 'object' && {
        contextWindowTokens: source.contextWindowTokens,
        maxOutputTokens: source.maxOutputTokens,
      }),
    };
  }
  /** Source identity for persisted vector-space hashes. The embedding endpoint was unchanged by the LLM protocol migration. */
  embeddingSpaceSource(modelId: string) {
    const source = this.ctx.db.get<{ baseUrl: string; apiMode: string }>(
      `SELECT p.base_url AS baseUrl,
        CASE WHEN m.legacy_embedding_fingerprint=1 THEN 'chat-completions' ELSE p.api_mode END AS apiMode
        FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=? AND m.kind='embedding'`,
      modelId,
    );
    if (!source) throw new HttpError(404, 'Embedding 模型不存在');
    return source;
  }
  decrypt(value: string) {
    return this.vault.decrypt(value);
  }
  encrypt(value: string) {
    return this.vault.encrypt(value);
  }
  adapter(mode: ApiMode = 'responses') {
    if (mode === 'responses') return this.ctx.adapters.get('openai-compatible');
    if (mode === 'anthropic-messages' || mode === 'jev') return this.ctx.adapters.get(mode);
    throw new HttpError(400, '模型来源协议不受支持，请在模型设置中更新来源');
  }
  async generateImage(
    user: User,
    modelId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ImageGenerationResult> {
    const model = this.authorize(user, modelId, 'image');
    prompt = z.string().trim().min(1).max(32_000).parse(prompt);
    const connection = this.connection(model);
    validateKind(connection.apiMode, 'image');
    const adapter = this.adapter(connection.apiMode);
    if (!adapter.generateImage) throw new HttpError(400, '此来源协议不支持图片生成');
    let usage: EmbeddingUsage | null = null;
    let status = 'error';
    try {
      const result = await adapter.generateImage(connection, model.name, prompt, signal);
      usage = result.usage;
      if (imageMimeType(result.data) !== result.mimeType)
        throw new ImageGenerationError('图片服务返回无效的图片文件', usage);
      signal.throwIfAborted();
      status = 'complete';
      return result;
    } catch (error) {
      if (error instanceof ImageGenerationError) usage = error.usage;
      status = signal.aborted ? 'cancelled' : 'error';
      throw error;
    } finally {
      this.ctx.db.run(
        'INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)',
        randomUUID(),
        user.id,
        `[图片生成] ${model.name}`,
        usage?.input ?? null,
        usage?.output ?? null,
        usage?.total ?? null,
        status,
        new Date().toISOString(),
      );
    }
  }
  async embed(
    user: User,
    modelId: string,
    inputs: string[],
    signal: AbortSignal,
    options: { dimensions?: number; expectedDimensions?: number; purpose?: string } = {},
  ): Promise<EmbeddingResult> {
    const model = this.authorize(user, modelId, 'embedding');
    embeddingInputs.parse(inputs);
    for (const value of [options.dimensions, options.expectedDimensions])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 16000))
        throw new HttpError(400, 'Embedding 维度必须为 1 至 16000 的整数');
    const connection = this.connection(model);
    validateKind(connection.apiMode, 'embedding');
    const adapter = this.adapter(connection.apiMode);
    if (!adapter.embed) throw new HttpError(400, '此来源协议不支持 Embedding');
    const dimensions = options.dimensions ?? model.embeddingDimensions ?? undefined;
    if (
      options.dimensions !== undefined &&
      model.embeddingDimensions !== null &&
      model.embeddingDimensions !== undefined &&
      options.dimensions !== model.embeddingDimensions
    )
      throw new HttpError(400, '请求维度与模型配置维度不一致，请先修改模型配置');
    const expected =
      options.expectedDimensions ?? dimensions ?? model.validatedDimensions ?? undefined;
    let usage: EmbeddingUsage | null = null;
    let status = 'error';
    try {
      const result = await adapter.embed(connection, model.name, inputs, signal, dimensions);
      usage = result.usage;
      const validated = validateEmbeddingResponse(
        result.vectors.map((embedding, index) => ({ embedding, index })),
        inputs.length,
        usage,
        expected,
      );
      status = 'complete';
      if (options.dimensions === undefined || options.dimensions === model.embeddingDimensions)
        this.ctx.db.run(
          "UPDATE models SET validated_dimensions=? WHERE id=? AND kind='embedding' AND name=? AND embedding_dimensions IS ? AND EXISTS(SELECT 1 FROM providers WHERE id=models.provider_id AND base_url=? AND api_mode=?)",
          validated.dimensions,
          model.id,
          model.name,
          model.embeddingDimensions ?? null,
          connection.baseUrl,
          connection.apiMode,
        );
      return validated;
    } catch (error) {
      if (error instanceof EmbeddingError) usage = error.usage;
      status = signal.aborted ? 'cancelled' : 'error';
      throw error;
    } finally {
      this.ctx.db.run(
        'INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)',
        randomUUID(),
        user.id,
        `[Embedding${options.purpose ? ` · ${options.purpose.slice(0, 60)}` : ''}] ${model.name}`,
        usage?.input ?? null,
        usage?.output ?? null,
        usage?.total ?? null,
        status,
        new Date().toISOString(),
      );
    }
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
        type Health = { state: 'checking' | 'ok' | 'error'; checkedAt: string | null };
        const health = new Map<string, Health>();
        const revisions = new Map<string, number>();
        let disposed = false;
        const probe = async (id: string) => {
          if (disposed) return;
          const revision = (revisions.get(id) ?? 0) + 1;
          revisions.set(id, revision);
          health.set(id, { state: 'checking', checkedAt: health.get(id)?.checkedAt ?? null });
          let state: Health['state'] = 'ok';
          try {
            const connection = ctx.models.connection(id);
            await ctx.models.adapter(connection.apiMode).discover(connection);
          } catch {
            state = 'error';
          }
          if (
            !disposed &&
            revisions.get(id) === revision &&
            ctx.db.get('SELECT id FROM providers WHERE id=?', id)
          )
            health.set(id, { state, checkedAt: new Date().toISOString() });
        };
        const probeAll = () => {
          if (disposed) return;
          for (const { id } of ctx.db.all<{ id: string }>('SELECT id FROM providers')) {
            if (health.get(id)?.state !== 'checking') void probe(id);
          }
        };
        let timer: ReturnType<typeof setTimeout>;
        const scheduleProbe = () => {
          timer = setTimeout(() => {
            probeAll();
            scheduleProbe();
          }, nextSourceProbeDelay());
          timer.unref();
        };
        scheduleProbe();
        queueMicrotask(probeAll);
        router.get('/models', requireUser, (req, res) => {
          const { kind } = z
            .object({ kind: z.enum(['llm', 'jev', 'embedding', 'image', 'all']).default('llm') })
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
              .map((p) => ({
                ...p,
                hasKey: !!ctx.models.connection(p.id).apiKey,
                health: health.get(p.id) ?? { state: 'unknown', checkedAt: null },
              })),
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
          void probe(id);
          res.status(201).json({ id });
        });
        router.post('/admin/providers/discover', async (req, res) => {
          const input = providerSchema
            .omit({ name: true, apiKey: true, platformUrl: true })
            .extend({
              id: z.string().uuid().optional(),
              apiKey: z.string().max(4096).optional(),
              apiMode: sourceProtocol.optional(),
            })
            .parse(req.body);
          const saved = input.id ? ctx.models.connection(input.id) : undefined;
          const connection = {
            baseUrl: input.baseUrl,
            apiMode: input.apiMode ?? saved?.apiMode ?? 'responses',
            apiKey: input.apiKey ?? saved?.apiKey ?? '',
          };
          res.json({ models: await ctx.models.adapter(connection.apiMode).discover(connection) });
        });
        router.post('/admin/models/:id/test', async (req, res) => {
          const { reasoningEffort, mode } = z
            .object({
              mode: z.enum(['text', 'tools']).default('text'),
              reasoningEffort: z
                .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
                .default('none'),
            })
            .strict()
            .parse(req.body ?? {});
          // Administrators may test a disabled model before making it available to users.
          const model = ctx.db.get<Model>(`${selectModels} WHERE m.id=?`, String(req.params.id));
          if (!model) throw new HttpError(404, '模型不存在');
          if (mode === 'tools' && (model.kind !== 'llm' || !model.toolCalling))
            throw new HttpError(400, '请先为已保存的 LLM 模型启用工具调用');
          if (model.kind === 'image')
            throw new HttpError(
              400,
              '图片模型通过产物工具生成时验证连接；连接测试不发送付费图片请求',
            );
          const connection = ctx.models.connection(model);
          const adapter = ctx.models.adapter(connection.apiMode);
          const record = (label: string, ok: boolean, usage: EmbeddingUsage | null) =>
            ctx.db.run(
              'INSERT INTO usage VALUES(?,?,?,?,?,?,?,?)',
              randomUUID(),
              req.user!.id,
              label,
              usage?.input ?? null,
              usage?.output ?? null,
              usage?.total ?? null,
              ok ? 'complete' : 'error',
              new Date().toISOString(),
            );
          if (mode === 'tools') {
            const test = await testToolConnection(
              adapter,
              connection,
              model.name,
              reasoningEffort,
              (round, index) =>
                record(`[工具测试 · 第 ${index + 1} 轮] ${model.name}`, round.ok, round.usage),
              () => {
                const saved = ctx.db.get<Model>(
                  `${selectModels} WHERE m.id=? AND m.kind='llm' AND m.tool_calling=1 AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role='admin')`,
                  model.id,
                  req.user!.id,
                );
                if (!saved || saved.name !== model.name || saved.providerId !== model.providerId)
                  throw new HttpError(409, '工具测试期间模型配置或管理员权限已变更');
                if (!isDeepStrictEqual(ctx.models.connection(saved), connection))
                  throw new HttpError(409, '工具测试期间来源或上下文配置已变更');
              },
            );
            res.json(test);
            return;
          }
          const result =
            model.kind === 'embedding'
              ? await testEmbeddingConnection(
                  adapter,
                  connection,
                  model.name,
                  model.embeddingDimensions ?? null,
                )
              : await testModelConnection(adapter, connection, model.name, reasoningEffort);
          if (model.kind === 'embedding' && result.ok)
            ctx.db.run(
              "UPDATE models SET validated_dimensions=? WHERE id=? AND kind='embedding' AND embedding_dimensions IS ? AND EXISTS(SELECT 1 FROM providers WHERE id=models.provider_id AND base_url=? AND api_mode=?)",
              result.actualDimensions!,
              model.id,
              model.embeddingDimensions ?? null,
              connection.baseUrl,
              connection.apiMode,
            );
          record(`[连接测试] ${model.name}`, result.ok, result.usage);
          res.json(result);
        });
        router.patch('/admin/providers/:id', (req, res) => {
          const input = providerSchema
            .omit({ apiKey: true })
            .extend({ apiKey: z.string().max(4096).optional(), apiMode: sourceProtocol.optional() })
            .parse(req.body);
          const id = String(req.params.id);
          const saved = ctx.models.connection(id);
          const mode = input.apiMode ?? saved.apiMode;
          if (
            mode !== 'responses' &&
            ctx.db.get(
              "SELECT id FROM models WHERE provider_id=? AND kind IN ('embedding','image')",
              id,
            )
          )
            throw new HttpError(
              400,
              '此来源已配置 Embedding 或图片模型，不能改为不支持该类型的协议',
            );
          ctx.db.transaction(() => {
            ctx.db.run(
              'UPDATE providers SET name=?,base_url=?,api_mode=? WHERE id=?',
              input.name,
              input.baseUrl.replace(/\/+$/, ''),
              mode,
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
            if (mode === 'jev') {
              ctx.db.run(
                "UPDATE models SET kind='jev',needs_protocol_review=0,context_window_tokens=NULL,max_output_tokens=NULL WHERE provider_id=?",
                id,
              );
            } else {
              ctx.db.run("UPDATE models SET kind='llm' WHERE provider_id=? AND kind='jev'", id);
            }
            ctx.db.run('UPDATE models SET validated_dimensions=NULL WHERE provider_id=?', id);
          });
          void probe(id);
          res.json({ ok: true });
        });
        router.delete('/admin/providers/:id', (req, res) => {
          const id = String(req.params.id);
          ctx.db.run('DELETE FROM providers WHERE id=?', id);
          revisions.set(id, (revisions.get(id) ?? 0) + 1);
          health.delete(id);
          res.json({ ok: true });
        });
        router.post('/admin/providers/:id/discover', async (req, res) => {
          const connection = ctx.models.connection(String(req.params.id));
          res.json({ models: await ctx.models.adapter(connection.apiMode).discover(connection) });
        });
        router.get('/admin/models', (_req, res) =>
          res.json(
            ctx.db.all<Model>(`${selectModels} ORDER BY m.sort_order,m.id`).map((m) => ({
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
          const mode = ctx.models.connection(input.providerId).apiMode;
          const kind = input.kind ?? (mode === 'jev' ? 'jev' : 'llm');
          validateKind(mode, kind);
          const limits = modelTokenLimits(kind, input);
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
            'INSERT INTO models(id,provider_id,name,label,vision,tool_calling,kind,embedding_dimensions,context_window_tokens,max_output_tokens,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM models))',
            id,
            input.providerId,
            input.name,
            input.label,
            Number(input.vision && kind === 'llm'),
            Number(input.toolCalling && kind === 'llm'),
            kind,
            kind === 'embedding' ? input.embeddingDimensions : null,
            limits.contextWindowTokens,
            limits.maxOutputTokens,
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
              ...tokenLimitsSchema.shape,
              enabled: z.boolean(),
              vision: z.boolean(),
              toolCalling: z.boolean().optional(),
              label: z.string().trim().min(1).max(100),
              userIds: z.array(z.string().uuid()).max(1000),
              kind: z.enum(['llm', 'jev', 'embedding', 'image']).optional(),
              embeddingDimensions: z.number().int().min(1).max(16000).nullable().optional(),
            })
            .parse(req.body);
          const id = String(req.params.id);
          const savedModel = ctx.db.get<Model>(`${selectModels} WHERE m.id=?`, id);
          if (!savedModel) throw new HttpError(404, '模型不存在');
          const kind = input.kind ?? savedModel.kind;
          validateKind(ctx.models.connection(savedModel.providerId).apiMode, kind);
          const limits = modelTokenLimits(kind, input, savedModel);
          const dimensions =
            kind === 'embedding'
              ? input.embeddingDimensions === undefined
                ? (savedModel.embeddingDimensions ?? null)
                : input.embeddingDimensions
              : null;
          ctx.db.transaction(() => {
            for (const userId of input.userIds)
              if (!ctx.db.get('SELECT id FROM users WHERE id=?', userId))
                throw new HttpError(400, '授权用户不存在');
            ctx.db.run(
              "UPDATE models SET enabled=?,needs_protocol_review=?,vision=?,tool_calling=?,label=?,kind=?,context_window_tokens=?,max_output_tokens=?,embedding_dimensions=?,legacy_embedding_fingerprint=CASE WHEN ?='embedding' THEN legacy_embedding_fingerprint ELSE 0 END,validated_dimensions=CASE WHEN kind=? AND embedding_dimensions IS ? THEN validated_dimensions ELSE NULL END WHERE id=?",
              Number(input.enabled),
              Number(Boolean(savedModel.needsProtocolReview) && !input.enabled && kind === 'llm'),
              Number(input.vision && kind === 'llm'),
              Number((input.toolCalling ?? savedModel.toolCalling) && kind === 'llm'),
              input.label,
              kind,
              limits.contextWindowTokens,
              limits.maxOutputTokens,
              dimensions,
              kind,
              kind,
              dimensions,
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
        ctx.effect(() => () => {
          disposed = true;
          clearTimeout(timer);
        });
      });
    },
  };
}
