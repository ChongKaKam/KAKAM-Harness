import { createHash, randomUUID } from 'node:crypto';
import { Service, type Context } from 'cordis';
import { z } from 'zod';
import { HttpError } from '../../kernel/http';
import type { User } from '../../shared/types';
import { productionMimeTypes } from './generators';
import {
  planIdentity,
  productionPlanInput,
  storedProductionPlan,
  productionImageMimeTypes,
  type ProductionPlanInput,
} from './delivery';
import {
  productionLimits,
  type ProductionArtifact,
  type ProductionDelivery,
  type ProductionDeliveryItem,
  type ProductionFormat,
  type ProductionMode,
  type ProductionList,
  type ProductionPreferences,
  type ProductionSettings,
  type ProductionSpace,
  type ProductionStorage,
} from './types';

const day = 86_400_000;
const columns = `a.id,a.name,a.mime_type AS mimeType,a.size,a.created_at AS createdAt,
  a.expires_at AS expiresAt,a.conversation_id AS conversationId,a.message_id AS messageId,
  a.group_id AS groupId,a.delivery_item_id AS deliveryItemId,
  COALESCE(g.name,c.title,'已删除对话的产物') AS spaceName`;
const joins = `FROM production_artifacts a
  LEFT JOIN conversation_groups g ON g.id=a.group_id AND g.user_id=a.user_id
  LEFT JOIN conversations c ON c.id=a.conversation_id AND c.user_id=a.user_id`;
const artifactSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid().optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .refine(
      (name) => !/[\x00-\x1f\x7f/\\]/.test(name) && !['.', '..'].includes(name),
      '文件名无效',
    ),
  mimeType: z
    .string()
    .max(160)
    .regex(/^[a-z][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i),
  idempotencyKey: z.string().min(1).max(200).optional(),
  deliveryItemId: z.string().uuid().nullable().optional(),
});
export const productionPreferencesPatch = z
  .object({
    enabled: z.boolean().optional(),
    temporaryRetentionDays: z.number().int().min(3).max(7).optional(),
    imageModelId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, '请提供需要修改的设置');

export interface CreateProductionArtifact {
  conversationId: string;
  messageId?: string;
  name: string;
  mimeType: string;
  data: Uint8Array;
  idempotencyKey?: string;
  deliveryItemId?: string | null;
}

export interface ProductionMessageScope {
  user: User;
  conversationId: string;
  messageId: string;
  requireDelivery?: boolean;
}

/** Private, bounded files. File bytes never become public static assets or host paths. */
export class ProductionService extends Service {
  static inject = ['db', 'models'];

  constructor(ctx: Context) {
    super(ctx, 'production', true);
    this.cleanup();
    const timer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    timer.unref();
    ctx.on('dispose', () => clearInterval(timer));
  }

  preferences(userId: string): ProductionPreferences {
    const saved = this.ctx.db.get<ProductionPreferences>(
      `SELECT enabled,temporary_retention_days AS temporaryRetentionDays,image_model_id AS imageModelId
       FROM production_preferences WHERE user_id=?`,
      userId,
    );
    return saved
      ? { ...saved, enabled: Boolean(saved.enabled) }
      : { enabled: true, temporaryRetentionDays: 7, imageModelId: null };
  }

  savePreferences(user: User, patch: Partial<ProductionPreferences>): ProductionPreferences {
    const input = productionPreferencesPatch.parse(patch);
    if (input.imageModelId) this.ctx.models.authorize(user, input.imageModelId, 'image');
    // Expired files stay expired when the owner later increases the retention window.
    this.cleanup();
    const next = { ...this.preferences(user.id), ...input };
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO production_preferences(user_id,enabled,temporary_retention_days,image_model_id)
         VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,
         temporary_retention_days=excluded.temporary_retention_days,image_model_id=excluded.image_model_id`,
        user.id,
        Number(next.enabled),
        next.temporaryRetentionDays,
        next.imageModelId,
      );
      if (input.temporaryRetentionDays !== undefined) {
        const files = this.ctx.db.all<{ id: string; startedAt: string }>(
          `SELECT id,COALESCE(temporary_started_at,created_at) AS startedAt
           FROM production_artifacts WHERE user_id=? AND group_id IS NULL`,
          user.id,
        );
        for (const file of files)
          this.ctx.db.run(
            'UPDATE production_artifacts SET expires_at=? WHERE id=? AND user_id=?',
            new Date(Date.parse(file.startedAt) + next.temporaryRetentionDays * day).toISOString(),
            file.id,
            user.id,
          );
      }
    });
    this.cleanup();
    return next;
  }

  storage(userId: string): ProductionStorage {
    this.cleanup();
    return {
      usedBytes: this.ctx.db.get<{ total: number }>(
        'SELECT COALESCE(SUM(size),0) AS total FROM production_artifacts WHERE user_id=?',
        userId,
      )!.total,
      limitBytes: productionLimits.accountBytes,
      maxFileBytes: productionLimits.fileBytes,
    };
  }

  settings(userId: string): ProductionSettings {
    return { preferences: this.preferences(userId), storage: this.storage(userId) };
  }

  private conversation(userId: string, id: string) {
    const conversation = this.ctx.db.get<{ id: string; title: string; groupId: string | null }>(
      'SELECT id,title,group_id AS groupId FROM conversations WHERE id=? AND user_id=?',
      id,
      userId,
    );
    if (!conversation) throw new HttpError(404, '对话不存在');
    return conversation;
  }

  private group(userId: string, id: string) {
    const group = this.ctx.db.get<{ id: string; name: string }>(
      'SELECT id,name FROM conversation_groups WHERE id=? AND user_id=?',
      id,
      userId,
    );
    if (!group) throw new HttpError(404, '分组不存在');
    return group;
  }

  private space(
    userId: string,
    kind: ProductionSpace['kind'],
    id: string,
    name: string,
  ): ProductionSpace {
    const filter =
      kind === 'group'
        ? 'group_id=?'
        : kind === 'conversation'
          ? 'group_id IS NULL AND conversation_id=?'
          : 'group_id IS NULL AND conversation_id IS NULL';
    const summary = this.ctx.db.get<{ artifactCount: number; size: number }>(
      `SELECT COUNT(*) AS artifactCount,COALESCE(SUM(size),0) AS size FROM production_artifacts
       WHERE user_id=? AND ${filter}`,
      userId,
      ...(kind === 'orphan' ? [] : [id]),
    )!;
    return { id, kind, name, ...summary };
  }

  spaces(userId: string): ProductionSpace[] {
    this.cleanup();
    const groups = this.ctx.db.all<{ id: string; name: string }>(
      'SELECT id,name FROM conversation_groups WHERE user_id=? ORDER BY created_at,id',
      userId,
    );
    const conversations = this.ctx.db.all<{ id: string; title: string }>(
      `SELECT id,title FROM conversations WHERE user_id=? AND group_id IS NULL ORDER BY updated_at DESC,id`,
      userId,
    );
    const spaces = [
      ...groups.map((group) => this.space(userId, 'group', group.id, group.name)),
      ...conversations.map((conversation) =>
        this.space(userId, 'conversation', conversation.id, conversation.title),
      ),
    ];
    const orphan = this.space(userId, 'orphan', 'orphan', '已删除对话的产物');
    if (orphan.artifactCount) spaces.push(orphan);
    return spaces;
  }

  list(userId: string, filter: { conversationId?: string; groupId?: string } = {}): ProductionList {
    if (filter.conversationId && filter.groupId) throw new HttpError(400, '请选择一个产物空间');
    this.cleanup();
    let space: ProductionSpace | null = null;
    let scope = '';
    let scopeId: string | undefined;
    if (filter.conversationId) {
      const conversation = this.conversation(userId, filter.conversationId);
      if (conversation.groupId) {
        const group = this.group(userId, conversation.groupId);
        space = this.space(userId, 'group', group.id, group.name);
        scope = ' AND a.group_id=?';
        scopeId = group.id;
      } else {
        space = this.space(userId, 'conversation', conversation.id, conversation.title);
        scope = ' AND a.group_id IS NULL AND a.conversation_id=?';
        scopeId = conversation.id;
      }
    } else if (filter.groupId) {
      const group = this.group(userId, filter.groupId);
      space = this.space(userId, 'group', group.id, group.name);
      scope = ' AND a.group_id=?';
      scopeId = group.id;
    }
    return {
      space,
      artifacts: this.ctx.db.all<ProductionArtifact>(
        `SELECT ${columns} ${joins} WHERE a.user_id=?${scope} ORDER BY a.created_at DESC,a.id`,
        userId,
        ...(scopeId ? [scopeId] : []),
      ),
    };
  }

  get(userId: string, id: string): ProductionArtifact {
    const artifact = this.ctx.db.get<ProductionArtifact>(
      `SELECT ${columns} ${joins} WHERE a.id=? AND a.user_id=?`,
      id,
      userId,
    );
    if (!artifact || (artifact.expiresAt !== null && Date.parse(artifact.expiresAt) <= Date.now()))
      throw new HttpError(404, '产物不存在或已过期');
    return artifact;
  }

  forMessage(userId: string, messageId: string): ProductionArtifact[] {
    return this.ctx.db.all<ProductionArtifact>(
      `SELECT ${columns} ${joins} WHERE a.user_id=? AND a.message_id=?
       AND (a.expires_at IS NULL OR a.expires_at>?) ORDER BY a.created_at,a.id`,
      userId,
      messageId,
      new Date().toISOString(),
    );
  }

  private message(userId: string, messageId: string, conversationId?: string) {
    const message = this.ctx.db.get<{
      conversationId: string;
      mode: ProductionMode;
      plan: string | null;
      imageFailure: string | null;
    }>(
      `SELECT m.conversation_id AS conversationId,m.production_mode AS mode,
       m.production_plan AS plan,m.production_image_failure AS imageFailure
       FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.id=? AND m.role='assistant' AND c.user_id=?`,
      messageId,
      userId,
    );
    if (!message || (conversationId && message.conversationId !== conversationId))
      throw new HttpError(404, '生成消息不存在');
    return message;
  }

  delivery(userId: string, messageId: string): ProductionDelivery | null {
    let saved: ReturnType<ProductionService['message']>;
    try {
      saved = this.message(userId, messageId);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
    if (!saved.plan) return null;
    const plan = storedProductionPlan.parse(JSON.parse(saved.plan));
    const artifacts = this.forMessage(userId, messageId);
    return {
      ...plan,
      items: plan.items.map((item): ProductionDeliveryItem => {
        const artifact = artifacts.find(
          (file) =>
            file.deliveryItemId === item.id &&
            (item.kind === 'image'
              ? productionImageMimeTypes.includes(file.mimeType)
              : item.format
                ? file.mimeType === productionMimeTypes[item.format]
                : !productionImageMimeTypes.includes(file.mimeType)),
        );
        return artifact
          ? { ...item, status: 'complete', artifactId: artifact.id, error: undefined }
          : { ...item, status: item.status === 'failed' ? 'failed' : 'pending' };
      }),
    };
  }

  declareDelivery(scope: ProductionMessageScope, input: ProductionPlanInput): ProductionDelivery {
    const parsed = productionPlanInput.parse(input);
    const message = this.message(scope.user.id, scope.messageId, scope.conversationId);
    if (!this.preferences(scope.user.id).enabled)
      throw new HttpError(400, '请先在产物设置中启用生成');
    if (message.plan) {
      const saved = storedProductionPlan.parse(JSON.parse(message.plan));
      if (planIdentity(saved) !== planIdentity(parsed))
        throw new HttpError(409, '本轮交付计划已锁定，不能修改或减少产物；请在新一轮提出修改');
      return this.delivery(scope.user.id, scope.messageId)!;
    }
    if (this.forMessage(scope.user.id, scope.messageId).length || message.imageFailure)
      throw new HttpError(409, '本轮已开始生成产物；请在生成前声明计划，或在新一轮规划多个产物');
    const plan: ProductionDelivery = {
      decision: parsed.decision,
      items: parsed.items.map((item) => ({ ...item, id: randomUUID(), status: 'pending' })),
      ...(parsed.question ? { question: parsed.question } : {}),
    };
    this.ctx.db.run(
      `UPDATE messages SET production_plan=? WHERE id=? AND conversation_id=?
       AND EXISTS(SELECT 1 FROM conversations WHERE id=messages.conversation_id AND user_id=?)`,
      JSON.stringify(plan),
      scope.messageId,
      scope.conversationId,
      scope.user.id,
    );
    return this.delivery(scope.user.id, scope.messageId)!;
  }

  /** The server binds each planned item to one actual file, never to model-supplied ownership. */
  deliveryItem(
    scope: ProductionMessageScope,
    itemId: string | null | undefined,
    kind: ProductionDeliveryItem['kind'],
    format?: ProductionFormat,
  ): { item?: ProductionDeliveryItem; artifact?: ProductionArtifact } {
    const message = this.message(scope.user.id, scope.messageId, scope.conversationId);
    const plan = this.delivery(scope.user.id, scope.messageId);
    if (!plan) {
      if (message.mode === 'required' || scope.requireDelivery)
        throw new HttpError(400, '必须先调用 production_plan 声明交付计划');
      if (itemId) throw new HttpError(400, '交付项目不存在');
      if (kind === 'image' && message.imageFailure)
        throw new HttpError(409, '本轮图片生成已失败，不会自动重复付费；请在新一轮重试');
      return {};
    }
    if (plan.decision !== 'deliver') throw new HttpError(409, '本轮需要澄清需求，不能直接生成产物');
    const item = plan.items.find((entry) => entry.id === itemId);
    if (!item || item.kind !== kind || (item.format && item.format !== format))
      throw new HttpError(400, '交付项目、产物类型或明确格式不匹配');
    if (item.artifactId) return { item, artifact: this.get(scope.user.id, item.artifactId) };
    if (item.status === 'failed')
      throw new HttpError(409, item.error ?? '本轮图片生成已失败，请在新一轮重试');
    return { item };
  }

  imageFailure(userId: string, messageId: string): string | null {
    return this.message(userId, messageId).imageFailure;
  }

  markImageFailed(scope: ProductionMessageScope, itemId: string | null | undefined, error: string) {
    const message = this.message(scope.user.id, scope.messageId, scope.conversationId);
    const safeError = error.slice(0, 500);
    if (message.plan && itemId) {
      const plan = storedProductionPlan.parse(JSON.parse(message.plan));
      const item = plan.items.find((entry) => entry.id === itemId && entry.kind === 'image');
      if (
        !item ||
        this.forMessage(scope.user.id, scope.messageId).some(
          (file) => file.deliveryItemId === itemId,
        )
      )
        return;
      item.status = 'failed';
      item.error = safeError;
      this.ctx.db.run(
        `UPDATE messages SET production_plan=? WHERE id=? AND conversation_id=?
         AND EXISTS(SELECT 1 FROM conversations WHERE id=messages.conversation_id AND user_id=?)`,
        JSON.stringify(plan),
        scope.messageId,
        scope.conversationId,
        scope.user.id,
      );
    } else {
      this.ctx.db.run(
        `UPDATE messages SET production_image_failure=? WHERE id=? AND conversation_id=?
         AND EXISTS(SELECT 1 FROM conversations WHERE id=messages.conversation_id AND user_id=?)`,
        safeError,
        scope.messageId,
        scope.conversationId,
        scope.user.id,
      );
    }
  }

  findCreated(userId: string, idempotencyKey: string): ProductionArtifact | undefined {
    const row = this.ctx.db.get<{ id: string }>(
      'SELECT id FROM production_artifacts WHERE user_id=? AND idempotency_key=?',
      userId,
      idempotencyKey,
    );
    if (!row) return undefined;
    try {
      return this.get(userId, row.id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  create(user: User, input: CreateProductionArtifact, signal?: AbortSignal): ProductionArtifact {
    signal?.throwIfAborted();
    const validated = artifactSchema.parse(input);
    const conversation = this.conversation(user.id, validated.conversationId);
    if (
      validated.messageId &&
      !this.ctx.db.get(
        `SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.id=? AND m.conversation_id=? AND c.user_id=? AND m.role='assistant'`,
        validated.messageId,
        conversation.id,
        user.id,
      )
    )
      throw new HttpError(404, '生成消息不存在');
    if (validated.deliveryItemId && !validated.messageId)
      throw new HttpError(400, '交付项目必须绑定生成消息');
    if (validated.messageId) {
      const kind = productionImageMimeTypes.includes(validated.mimeType) ? 'image' : 'file';
      const format = Object.entries(productionMimeTypes).find(
        ([, mime]) => mime === validated.mimeType,
      )?.[0] as ProductionFormat | undefined;
      const delivery = this.deliveryItem(
        { user, conversationId: conversation.id, messageId: validated.messageId },
        validated.deliveryItemId,
        kind,
        format,
      );
      if (delivery.artifact) return delivery.artifact;
    }
    if (!(input.data instanceof Uint8Array) || input.data.byteLength > productionLimits.fileBytes)
      throw new HttpError(400, '产物文件超过 20 MiB 限制');
    const hash = createHash('sha256').update(input.data).digest('hex');
    if (validated.idempotencyKey) {
      const existing = this.ctx.db.get<{
        id: string;
        name: string;
        mime_type: string;
        content_hash: string;
        conversation_id: string | null;
        message_id: string | null;
        delivery_item_id: string | null;
      }>(
        'SELECT id,name,mime_type,content_hash,conversation_id,message_id,delivery_item_id FROM production_artifacts WHERE user_id=? AND idempotency_key=?',
        user.id,
        validated.idempotencyKey,
      );
      if (existing) {
        if (
          existing.name !== validated.name ||
          existing.mime_type !== validated.mimeType ||
          existing.content_hash !== hash ||
          existing.conversation_id !== conversation.id ||
          existing.message_id !== (validated.messageId ?? null) ||
          existing.delivery_item_id !== (validated.deliveryItemId ?? null)
        )
          throw new HttpError(409, '产物请求标识已被其他内容使用');
        return this.get(user.id, existing.id);
      }
    }
    if (!this.preferences(user.id).enabled) throw new HttpError(400, '请先在产物设置中启用生成');
    this.cleanup();
    if (this.storage(user.id).usedBytes + input.data.byteLength > productionLimits.accountBytes)
      throw new HttpError(400, '产物空间已达到 200 MiB，请删除部分文件后重试');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const groupId = conversation.groupId;
    if (groupId) this.group(user.id, groupId);
    const expiresAt = groupId
      ? null
      : new Date(
          Date.parse(createdAt) + this.preferences(user.id).temporaryRetentionDays * day,
        ).toISOString();
    signal?.throwIfAborted();
    this.ctx.db.run(
      `INSERT INTO production_artifacts(id,user_id,conversation_id,message_id,group_id,name,mime_type,
       size,data,content_hash,created_at,temporary_started_at,expires_at,idempotency_key,delivery_item_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      user.id,
      conversation.id,
      validated.messageId ?? null,
      groupId,
      validated.name,
      validated.mimeType,
      input.data.byteLength,
      input.data,
      hash,
      createdAt,
      groupId ? null : createdAt,
      expiresAt,
      validated.idempotencyKey ?? null,
      validated.deliveryItemId ?? null,
    );
    return this.get(user.id, id);
  }

  download(userId: string, id: string): { artifact: ProductionArtifact; data: Uint8Array } {
    const artifact = this.get(userId, id);
    const saved = this.ctx.db.get<{ data: Uint8Array }>(
      'SELECT data FROM production_artifacts WHERE id=? AND user_id=?',
      id,
      userId,
    )!;
    return { artifact, data: saved.data };
  }

  remove(userId: string, id: string): void {
    this.get(userId, id);
    this.ctx.db.run('DELETE FROM production_artifacts WHERE id=? AND user_id=?', id, userId);
  }

  adoptConversationArtifacts(userId: string, conversationId: string, groupId: string): void {
    this.conversation(userId, conversationId);
    this.group(userId, groupId);
    this.cleanup();
    this.ctx.db.run(
      `UPDATE production_artifacts SET group_id=?,temporary_started_at=NULL,expires_at=NULL
       WHERE user_id=? AND conversation_id=? AND group_id IS NULL`,
      groupId,
      userId,
      conversationId,
    );
  }

  releaseGroupArtifacts(userId: string, groupId: string): void {
    this.group(userId, groupId);
    const startedAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.parse(startedAt) + this.preferences(userId).temporaryRetentionDays * day,
    ).toISOString();
    const artifacts = this.ctx.db.all<{
      id: string;
      conversationId: string | null;
      currentGroupId: string | null;
    }>(
      `SELECT a.id,a.conversation_id AS conversationId,c.group_id AS currentGroupId
       FROM production_artifacts a LEFT JOIN conversations c ON c.id=a.conversation_id AND c.user_id=a.user_id
       WHERE a.user_id=? AND a.group_id=?`,
      userId,
      groupId,
    );
    // The caller includes this update and group deletion in the same synchronous transaction.
    for (const artifact of artifacts) {
      const destination = artifact.currentGroupId !== groupId ? artifact.currentGroupId : null;
      this.ctx.db.run(
        `UPDATE production_artifacts SET group_id=?,temporary_started_at=?,expires_at=?
         WHERE id=? AND user_id=?`,
        destination,
        destination ? null : startedAt,
        destination ? null : expiresAt,
        artifact.id,
        userId,
      );
    }
  }

  removeConversationArtifacts(userId: string, conversationId: string): void {
    this.conversation(userId, conversationId);
    this.ctx.db.run(
      'DELETE FROM production_artifacts WHERE user_id=? AND conversation_id=? AND group_id IS NULL',
      userId,
      conversationId,
    );
  }

  cleanup(now = Date.now()): number {
    // A group removed outside the normal route must never leave immortal orphan files.
    this.ctx.db.run(
      `UPDATE production_artifacts SET temporary_started_at=COALESCE(temporary_started_at,created_at),
       expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(temporary_started_at,created_at),
         '+' || COALESCE((SELECT temporary_retention_days FROM production_preferences p WHERE p.user_id=production_artifacts.user_id),7) || ' days')
       WHERE group_id IS NULL AND expires_at IS NULL`,
    );
    return Number(
      this.ctx.db.run(
        'DELETE FROM production_artifacts WHERE expires_at IS NOT NULL AND expires_at<=?',
        new Date(now).toISOString(),
      ).changes,
    );
  }
}
