import { Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { requireAdmin, requireUser } from '../../kernel/http';
import {
  ProductionService,
  productionPreferencesPatch,
  productionAdminSettingsInput,
} from './service';
import { registerProductionTools } from './tools';
export { manifest } from './manifest';

/** Only inert, verified media retain their original type on the private content route. */
function contentType(mimeType: string, data: Buffer): string | null {
  const mime = mimeType.toLowerCase();
  if (mime === 'image/png')
    return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? mime : null;
  if (mime === 'image/jpeg')
    return data[0] === 255 && data[1] === 216 && data[2] === 255 ? mime : null;
  if (mime === 'image/webp')
    return data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
      ? mime
      : null;
  if (mime === 'application/pdf')
    return data.subarray(0, 5).equals(Buffer.from('%PDF-')) ? mime : null;
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml')
  )
    return 'text/plain; charset=utf-8';
  return null;
}

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
      const adminBase = '/admin/llm-production/settings';
      router.use(adminBase, requireAdmin);
      router.get(adminBase, (_req, res) => res.json(ctx.production.adminSettings()));
      router.patch(adminBase, (req, res) =>
        res.json(
          ctx.production.saveAdminSettings(req.user!, productionAdminSettingsInput.parse(req.body)),
        ),
      );
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
      router.get(`${base}/artifacts/:id/content`, (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
        const { artifact, data } = ctx.production.download(req.user!.id, id.parse(req.params.id));
        const bytes = Buffer.from(data);
        const mime = contentType(artifact.mimeType, bytes);
        if (mime) res.set('Content-Disposition', 'inline').type(mime);
        else res.attachment(artifact.name).type('application/octet-stream');
        res.send(bytes);
      });
      router.delete(`${base}/artifacts/:id`, (req, res) => {
        ctx.production.remove(req.user!.id, id.parse(req.params.id));
        res.json({ ok: true });
      });
      ctx.effect(() => ctx.http.register(router));
    });
  },
};
