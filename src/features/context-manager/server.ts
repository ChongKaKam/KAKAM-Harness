import { Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { HttpError, requireUser } from '../../kernel/http';
import { ContextStore } from './store';
import type { ContextHandoff } from './types';
import { contextPreferences, contextPreferencesSchema } from './preferences';
import { ContextProcessing } from './processing';
export { manifest } from './manifest';

const preferencesSchema = contextPreferencesSchema.partial();
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
    const processing = new ContextProcessing(ctx);
    ctx.effect(() => () => processing.dispose());
    ctx.effect(() => ctx.extensions.registerContextObserver(store));
    ctx.effect(() => ctx.extensions.registerContextProcessor(processing));
    ctx.effect(() =>
      ctx.extensions.registerUtility('context-compression', '上下文压缩', {
        maxCharacters: 16_000,
        timeoutMs: 60_000,
      }),
    );
    ctx.effect(() =>
      ctx.extensions.registerUtility('context-trajectory', '轨迹摘要', {
        maxCharacters: 6000,
        timeoutMs: 60_000,
      }),
    );
    ctx.effect(() =>
      ctx.extensions.registerUtility('context-handoff', 'Hand-off', {
        maxCharacters: 32_000,
        timeoutMs: 120_000,
      }),
    );
    router.use('/context-manager', requireUser);
    const preferences = (userId: string) => contextPreferences(ctx.db, userId);
    router.get('/context-manager/preferences', (req, res) => res.json(preferences(req.user!.id)));
    router.patch('/context-manager/preferences', (req, res) => {
      const input = { ...preferences(req.user!.id), ...preferencesSchema.parse(req.body) };
      for (const modelId of [
        input.handoffModelId,
        input.compressionModelId,
        input.trajectoryModelId,
      ])
        if (modelId) ctx.models.authorize(req.user!, modelId, 'llm');
      if (input.compressionEnabled && !input.compressionModelId)
        throw new HttpError(400, '启用自动压缩前请选择压缩模型');
      if (input.compressionEnabled && input.compressionMaxCharacters >= input.compressionThreshold)
        throw new HttpError(400, '摘要预算必须小于压缩触发阈值');
      if (input.trajectoryEnabled && !input.trajectoryModelId)
        throw new HttpError(400, '启用轨迹摘要前请选择摘要模型');
      ctx.db.run(
        'INSERT INTO context_preferences(user_id,handoff_model_id,config) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET handoff_model_id=excluded.handoff_model_id,config=excluded.config',
        req.user!.id,
        input.handoffModelId,
        JSON.stringify(input),
      );
      res.json(input);
    });
    router.get('/context-manager/conversations/:id/turns', (req, res) =>
      res.json(store.list(req.user!.id, conversationId(req.params.id))),
    );
    router.post('/context-manager/conversations/:id/turns/:messageId/summary', async (req, res) => {
      const input = z.object({ modelId: z.string().uuid().optional() }).parse(req.body);
      const id = conversationId(req.params.id);
      const messageId = z.string().uuid().parse(req.params.messageId);
      const snapshot = store.get(req.user!.id, id, messageId);
      if (snapshot.status !== 'complete')
        throw new HttpError(400, '只能为已完成的对话轮次生成摘要');
      const modelId = input.modelId ?? preferences(req.user!.id).trajectoryModelId;
      if (!modelId) throw new HttpError(400, '请先配置轨迹摘要模型');
      ctx.models.authorize(req.user!, modelId, 'llm');
      const abort = new AbortController();
      const disconnected = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.on('close', disconnected);
      try {
        res.json(
          await processing.summarize(
            {
              user: req.user!,
              conversationId: id,
              messageId,
              current:
                snapshot.sections.find((section) => section.id === 'current')?.entries[0]
                  ?.content ?? snapshot.prompt,
              response: {
                id: messageId,
                role: 'assistant',
                content: snapshot.response,
                images: [],
                status: 'complete',
                createdAt: snapshot.createdAt,
              },
            },
            modelId,
            abort.signal,
          ),
        );
      } finally {
        res.off('close', disconnected);
      }
    });
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
