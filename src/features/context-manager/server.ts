import { Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
import { ContextStore } from './store';
import type { ContextHandoff, ContextPreferences } from './types';
export { manifest } from './manifest';

const preferencesSchema = z.object({ handoffModelId: z.string().uuid().nullable() });
const handoffSchema = z.object({
  messageId: z.string().uuid(),
  modelId: z.string().uuid().optional(),
});
const conversationId = (id: unknown) => z.string().uuid().parse(id);

export const server = {
  name: 'context-manager',
  inject: ['db', 'http', 'models', 'extensions'],
  apply(ctx: Context) {
    const router = Router();
    const store = new ContextStore(ctx.db);
    ctx.effect(() => ctx.extensions.registerContextObserver(store));
    ctx.effect(() =>
      ctx.extensions.registerUtility('context-handoff', 'Hand-off', {
        maxCharacters: 32_000,
        timeoutMs: 120_000,
      }),
    );
    router.use('/context-manager', requireUser);
    const preferences = (userId: string): ContextPreferences =>
      ctx.db.get<ContextPreferences>(
        'SELECT handoff_model_id AS handoffModelId FROM context_preferences WHERE user_id=?',
        userId,
      ) ?? { handoffModelId: null };
    router.get('/context-manager/preferences', (req, res) => res.json(preferences(req.user!.id)));
    router.patch('/context-manager/preferences', (req, res) => {
      const input = preferencesSchema.parse(req.body);
      if (input.handoffModelId) ctx.models.authorize(req.user!, input.handoffModelId, 'llm');
      ctx.db.run(
        'INSERT INTO context_preferences(user_id,handoff_model_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET handoff_model_id=excluded.handoff_model_id',
        req.user!.id,
        input.handoffModelId,
      );
      res.json(input);
    });
    router.get('/context-manager/conversations/:id/turns', (req, res) =>
      res.json(store.list(req.user!.id, conversationId(req.params.id))),
    );
    router.get('/context-manager/conversations/:id/turns/:messageId', (req, res) =>
      res.json(
        store.get(
          req.user!.id,
          conversationId(req.params.id),
          z.string().uuid().parse(req.params.messageId),
        ),
      ),
    );
    router.post('/context-manager/conversations/:id/handoff', async (req, res) => {
      const input = handoffSchema.parse(req.body);
      const id = conversationId(req.params.id);
      const prompt = store.handoffPrompt(req.user!.id, id, input.messageId);
      const modelId = input.modelId ?? preferences(req.user!.id).handoffModelId;
      if (!modelId)
        throw new HttpError(
          400,
          '请先在设置 → 上下文管理中选择 Hand-off 模型，或在本次生成时选择模型',
        );
      const model = ctx.models.authorize(req.user!, modelId, 'llm');
      const abort = new AbortController();
      const disconnected = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on('close', disconnected);
      try {
        const result = await ctx.extensions.generateUtility(
          req.user!,
          'context-handoff',
          modelId,
          prompt,
          abort.signal,
        );
        const handoff: ContextHandoff = {
          markdown: result.text,
          usage: result.usage,
          createdAt: new Date().toISOString(),
          modelName: model.label,
          throughMessageId: input.messageId,
        };
        res.json(handoff);
      } finally {
        res.off('close', disconnected);
      }
    });
    ctx.effect(() => ctx.http.register(router));
  },
};
