import { randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import { Router } from 'express';
import { z } from 'zod';
import { digest } from '../../kernel/crypto';
import { HttpError, requireAdmin } from '../../kernel/http';
import type { User } from '../../shared/types';
import { publicUser } from '../auth/server';
import { dashboardQuery, readGatewayDashboard } from './dashboard-data';

export function isOpenAIProvider(baseUrl: string, apiMode: string) {
  return (
    (apiMode === 'responses' || apiMode === 'chat-completions') &&
    baseUrl.replace(/\/+$/, '') === 'https://api.openai.com/v1'
  );
}

export function resolveGatewayKey(ctx: Context, authorization?: string) {
  const token = /^Bearer (dsk_[\w-]{43})$/i.exec(authorization ?? '')?.[1];
  const row =
    token &&
    ctx.db.get<User & { providerId: string }>(
      `SELECT u.id,u.email,u.username AS legacyUsername,u.display_name AS displayName,
        u.avatar,u.role,u.active,k.provider_id AS providerId
      FROM openai_gateway_keys k JOIN users u ON u.id=k.user_id
      WHERE k.key_hash=? AND u.active=1 AND u.role='admin'`,
      digest(token),
    );
  if (!row) throw new HttpError(401, '转发 Key 无效或已撤销');
  return { user: publicUser(row), providerId: row.providerId };
}

export function createKeyRouter(ctx: Context) {
  const router = Router();
  const root = '/admin/openai-gateway';
  router.use(root, requireAdmin, (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get(root + '/dashboard', (req, res) => {
    const { days } = dashboardQuery.parse(req.query);
    res.json(readGatewayDashboard(ctx.db, req.user!.id, days));
  });
  router.get(root, (req, res) => {
    const providers = ctx.db
      .all<{ id: string; name: string; baseUrl: string; apiMode: string }>(
        'SELECT id,name,base_url AS baseUrl,api_mode AS apiMode FROM providers ORDER BY name,id',
      )
      .filter((p) => isOpenAIProvider(p.baseUrl, p.apiMode) && ctx.models.connection(p.id).apiKey)
      .map(({ id, name }) => ({ id, name }));
    const keys = ctx.db.all(
      `SELECT k.id,k.name,k.prefix,k.created_at AS createdAt,k.provider_id AS providerId,p.name AS providerName
        FROM openai_gateway_keys k JOIN providers p ON p.id=k.provider_id
        WHERE k.user_id=? ORDER BY k.created_at DESC,k.id`,
      req.user!.id,
    );
    res.json({ providers, keys });
  });
  router.post(root + '/keys', (req, res) => {
    const { name, providerId } = z
      .object({
        name: z.string().trim().min(1).max(80),
        providerId: z.uuid(),
      })
      .strict()
      .parse(req.body);
    const connection = ctx.models.connection(providerId);
    if (!isOpenAIProvider(connection.baseUrl, connection.apiMode) || !connection.apiKey)
      throw new HttpError(400, '请选择已配置 API Key 的 OpenAI 官方来源');
    const key = 'dsk_' + randomBytes(32).toString('base64url');
    ctx.db.run(
      'INSERT INTO openai_gateway_keys(id,user_id,provider_id,name,prefix,key_hash,created_at) VALUES(?,?,?,?,?,?,?)',
      randomUUID(),
      req.user!.id,
      providerId,
      name,
      key.slice(0, 12),
      digest(key),
      Date.now(),
    );
    res.status(201).json({ key });
  });
  router.delete(root + '/keys/:id', (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const result = ctx.db.run(
      'DELETE FROM openai_gateway_keys WHERE user_id=? AND id=?',
      req.user!.id,
      id,
    );
    if (!result.changes) throw new HttpError(404, '转发 Key 不存在');
    res.json({ ok: true });
  });
  return router;
}
