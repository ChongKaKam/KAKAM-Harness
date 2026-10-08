import { Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { requireUser } from '../../kernel/http';
import { ProductionService, productionPreferencesPatch } from './service';
import { registerProductionTools } from './tools';
export { manifest } from './manifest';

export const server = {
  name: 'llm-production',
  inject: ['db', 'http', 'models', 'extensions'],
  apply(ctx: Context) {
    ctx.plugin(ProductionService);
    ctx.inject(['production', 'http'], (ctx) => {
      ctx.effect(() => registerProductionTools(ctx));
      const router = Router();
      const base = '/llm-production';
      const id = z.string().uuid();
      router.use(base, requireUser);
      router.get(`${base}/preferences`, (req, res) =>
        res.json(ctx.production.preferences(req.user!.id)),
      );
      router.patch(`${base}/preferences`, (req, res) =>
        res.json(
          ctx.production.savePreferences(req.user!, productionPreferencesPatch.parse(req.body)),
        ),
      );
      router.get(`${base}/settings`, (req, res) => res.json(ctx.production.settings(req.user!.id)));
      router.get(`${base}/spaces`, (req, res) => res.json(ctx.production.spaces(req.user!.id)));
      router.get(`${base}/artifacts`, (req, res) => {
        const filter = z
          .object({ conversationId: id.optional(), groupId: id.optional() })
          .parse(req.query);
        res.json(ctx.production.list(req.user!.id, filter));
      });
      router.get(`${base}/artifacts/:id/download`, (req, res) => {
        const { artifact, data } = ctx.production.download(req.user!.id, id.parse(req.params.id));
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.attachment(artifact.name).type(artifact.mimeType).send(Buffer.from(data));
      });
      router.delete(`${base}/artifacts/:id`, (req, res) => {
        ctx.production.remove(req.user!.id, id.parse(req.params.id));
        res.json({ ok: true });
      });
      ctx.effect(() => ctx.http.register(router));
    });
  },
};
