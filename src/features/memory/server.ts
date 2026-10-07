import { Router } from 'express';
import type { Context } from 'cordis';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MemoryDatabase } from '../../kernel/memory-database';
import type { MemoryDatabaseOptions } from '../../kernel/memory-config';
import { HttpError, requireUser } from '../../kernel/http';
import { MemoryManager } from './manager';
import { PgMemoryRepository, type MemoryRepository } from './repository';
import { memoryInputSchema, preferencesSchema, scopes, kinds, sourceSchema } from './config';
import type { MemoryScope } from '../../shared/memory';
export { manifest } from './manifest';

const id = z.string().uuid();
const key = z.string().min(1).max(128).optional();
const preferencesPatch = preferencesSchema.partial().extend({
  writeModes: preferencesSchema.shape.writeModes.partial().optional(),
  retentionDays: preferencesSchema.shape.retentionDays.partial().optional(),
});
const memoryPatch = z
  .object({
    version: z.number().int().positive(),
    kind: z.enum(kinds).optional(),
    content: z.string().trim().min(1).max(8000).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    pinned: z.boolean().optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const operationFilter = z.object({ conversationId: id.optional(), messageId: id.optional() });
export interface MemoryFeatureOptions {
  databaseUrl?: string;
  namespace?: string;
  databaseOptions?: MemoryDatabaseOptions;
  repository?: MemoryRepository;
}
export function createMemoryFeature(options: MemoryFeatureOptions = {}) {
  return {
    name: 'memory',
    inject: ['db', 'http', 'models', 'extensions', 'kernel'],
    apply(ctx: Context) {
      const repository =
        options.repository ??
        new PgMemoryRepository(
          new MemoryDatabase(options.databaseUrl, options.databaseOptions),
          options.namespace ?? 'drift-space',
        );
      ctx.plugin(MemoryManager, {
        repository,
        configured: !!options.databaseUrl || !!options.repository,
      });
      ctx.inject(['memory', 'http', 'extensions'], (ctx) => {
        const router = Router(),
          manager = ctx.memory,
          base = '/memory/v1';
        router.use(base, requireUser);
        router.get(`${base}/status`, async (req, res) => res.json(await manager.status(req.user!)));
        router.get(`${base}/strategies`, (_req, res) => res.json(manager.strategies.list()));
        router.get(`${base}/preferences`, async (req, res) =>
          res.json(await manager.preferences(req.user!)),
        );
        router.patch(`${base}/preferences`, async (req, res) =>
          res.json(await manager.savePreferences(req.user!, preferencesPatch.parse(req.body))),
        );
        router.get(`${base}/strategies/:id/config`, async (req, res) =>
          res.json(await manager.strategyConfig(req.user!, String(req.params.id))),
        );
        router.patch(`${base}/strategies/:id/config`, async (req, res) => {
          const input = z
            .object({ version: z.number().int().min(0), config: z.record(z.string(), z.unknown()) })
            .strict()
            .parse(req.body);
          if (JSON.stringify(input.config).length > 64000) throw new HttpError(400, '策略设置过长');
          res.json(
            await manager.saveConfig(req.user!, String(req.params.id), input.version, input.config),
          );
        });
        router.get(`${base}/memories`, async (req, res) => {
          await manager.preferences(req.user!);
          const input = z
            .object({
              scope: z.enum(scopes).optional(),
              scopeId: id.optional(),
              query: z.string().max(200).optional(),
              status: z.enum(['pending', 'active', 'review']).optional(),
            })
            .parse(req.query);
          if (input.scope && input.scopeId)
            manager.validateScope(req.user!, input.scope, input.scopeId);
          res.json(await repository.list(req.user!.id, input));
        });
        router.post(`${base}/memories`, async (req, res) => {
          const body = z
            .object({ idempotencyKey: key, sources: z.array(sourceSchema).max(20).default([]) })
            .parse(req.body);
          res
            .status(201)
            .json(
              await manager.create(
                req.user!,
                memoryInputSchema.parse(req.body),
                body.sources,
                body.idempotencyKey,
              ),
            );
        });
        router.get(`${base}/memories/:id`, async (req, res) =>
          res.json(await repository.get(req.user!.id, id.parse(req.params.id))),
        );
        router.patch(`${base}/memories/:id`, async (req, res) => {
          const { version, ...patch } = memoryPatch.parse(req.body);
          res.json(await manager.update(req.user!, id.parse(req.params.id), version, patch));
        });
        router.get(`${base}/memories/:id/sources`, async (req, res) =>
          res.json(await manager.sourceExcerpts(req.user!, id.parse(req.params.id))),
        );
        router.post(`${base}/memories/:id/admission`, async (req, res) => {
          const input = z
            .object({
              version: z.number().int().positive(),
              decision: z.enum(['include', 'withdraw']),
            })
            .strict()
            .parse(req.body);
          res.json(
            await manager.admission(
              req.user!,
              id.parse(req.params.id),
              input.version,
              input.decision === 'include',
            ),
          );
        });
        router.post(`${base}/remember`, async (req, res) => {
          const input = z.object({ conversationId: id, messageId: id }).strict().parse(req.body);
          const abort = new AbortController();
          const close = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.on('close', close);
          try {
            res.json(
              await manager.remember(
                req.user!,
                input.conversationId,
                input.messageId,
                abort.signal,
              ),
            );
          } finally {
            res.off('close', close);
          }
        });
        router.post(`${base}/remember/:id/confirm`, async (req, res) => {
          const input = z
            .object({
              scope: z.enum(['user', 'group']),
              content: z.string().trim().min(1).max(8000).optional(),
            })
            .strict()
            .parse(req.body);
          res.json(
            await manager.confirmRemember(
              req.user!,
              id.parse(req.params.id),
              input.scope,
              input.content,
            ),
          );
        });
        router.delete(`${base}/memories/:id`, async (req, res) => {
          await manager.delete(req.user!, id.parse(req.params.id));
          res.json({ ok: true });
        });
        router.post(`${base}/search`, async (req, res) => {
          const input = z
            .object({
              query: z.string().trim().min(1).max(8000),
              conversationId: id.optional(),
              limit: z.number().int().min(1).max(120).optional(),
            })
            .parse(req.body);
          res.json(await manager.search(req.user!, input.query, input.conversationId, input.limit));
        });
        router.post(`${base}/prepare-turn`, async (req, res) => {
          const input = z
            .object({
              conversationId: id,
              messageId: id.optional(),
              current: z.string().trim().min(1).max(8000).optional(),
            })
            .parse(req.body);
          const { groupId } = manager.conversation(req.user!, input.conversationId);
          const history = ctx.db
            .all<{
              id: string;
              role: 'user' | 'assistant';
              content: string;
              status: 'complete';
              createdAt: string;
            }>(
              'SELECT id,role,content,status,created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY rowid',
              input.conversationId,
            )
            .map((row) => ({ ...row, images: [] }));
          const current = input.current ?? history.findLast((x) => x.role === 'user')?.content;
          if (!current) throw new HttpError(400, '请提供当前问题或保存一条用户消息');
          res.json(
            await manager.prepare({
              user: req.user!,
              conversationId: input.conversationId,
              messageId: input.messageId ?? randomUUID(),
              groupId,
              history,
              current,
              signal: new AbortController().signal,
            }),
          );
        });
        router.post(`${base}/extract`, async (req, res) => {
          const input = z
            .object({ conversationId: id, messageId: id.optional(), idempotencyKey: key })
            .parse(req.body);
          const turn = manager.turnFromDatabase(req.user!, input.conversationId, input.messageId);
          res.status(202).json(await manager.startExtraction(turn, input.idempotencyKey));
        });
        router.get(`${base}/proposals`, async (req, res) => {
          await manager.preferences(req.user!);
          const input = operationFilter
            .extend({
              state: z
                .enum(['all', 'pending', 'approved', 'rejected', 'invalidated'])
                .default('pending'),
            })
            .parse(req.query);
          const rows = await repository.proposals(req.user!.id, input.state);
          res.json(
            rows.filter(
              (row) =>
                row.sources.some(
                  (source) =>
                    (!input.conversationId || source.conversationId === input.conversationId) &&
                    (!input.messageId || source.messageId === input.messageId),
                ) ||
                (!input.conversationId && !input.messageId),
            ),
          );
        });
        router.post(`${base}/proposals`, async (req, res) => {
          const value = memoryInputSchema.parse(req.body),
            sources = z.array(sourceSchema).min(1).max(20).parse(req.body.sources);
          res.status(201).json(await manager.propose(req.user!, { ...value, sources }));
        });
        router.post(`${base}/proposals/:id/decision`, async (req, res) => {
          const input = z
            .object({ decision: z.enum(['approve', 'reject']) })
            .strict()
            .parse(req.body);
          res.json(
            await manager.decide(req.user!, id.parse(req.params.id), input.decision === 'approve'),
          );
        });
        for (const [path, scope] of [
          ['sessions', 'session'],
          ['groups', 'group'],
        ] as const) {
          router.get(`${base}/${path}/:id/state`, async (req, res) =>
            res.json(await manager.scopeState(req.user!, scope, id.parse(req.params.id))),
          );
          router.patch(`${base}/${path}/:id/state`, async (req, res) => {
            const { revision, ...patch } = z
              .object({
                revision: z.number().int().min(0),
                summary: z.string().max(8000).optional(),
                selections: z.record(id, z.enum(['prefer', 'exclude']).nullable()).optional(),
              })
              .strict()
              .parse(req.body);
            res.json(
              await manager.saveScopeState(
                req.user!,
                scope,
                id.parse(req.params.id),
                revision,
                patch,
              ),
            );
          });
        }
        router.post(`${base}/indexes/rebuild`, async (req, res) => {
          const input = z.object({ idempotencyKey: key }).parse(req.body ?? {});
          res.status(202).json(await manager.rebuild(req.user!, input.idempotencyKey));
        });
        router.get(`${base}/operations`, async (req, res) => {
          const input = operationFilter.parse(req.query);
          res.json(
            await repository.operations(req.user!.id, input.conversationId, input.messageId),
          );
        });
        router.get(`${base}/operations/:id`, async (req, res) =>
          res.json(await repository.getOperation(req.user!.id, id.parse(req.params.id))),
        );
        router.post(`${base}/operations/:id/cancel`, async (req, res) =>
          res.json(await manager.cancel(req.user!, id.parse(req.params.id))),
        );
        router.post(`${base}/operations/:id/retry`, async (req, res) =>
          res.status(202).json(await manager.retry(req.user!, id.parse(req.params.id))),
        );
        ctx.effect(() => ctx.http.register(router));
      });
    },
  };
}
export const server = createMemoryFeature();
