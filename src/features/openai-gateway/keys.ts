import { randomBytes, randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import { Router } from 'express';
import { z } from 'zod';
import { digest, type SecretVault } from '../../kernel/crypto';
import { HttpError, requireAdmin } from '../../kernel/http';
import { dashboardQuery, readGatewayDashboard } from './dashboard-data';

const apiKeySchema = z
  .string()
  .trim()
  .max(4096)
  .regex(/^[!-~]+$/, '请输入有效的 OpenAI API Key');

function readCredential(vault: SecretVault, encrypted?: string | null) {
  if (!encrypted) return;
  try {
    const credential = apiKeySchema.safeParse(vault.decrypt(encrypted));
    if (credential.success) return credential.data;
  } catch {
    // Unreadable credentials can be replaced in settings without exposing vault errors.
  }
}

function configuredKey(ctx: Context, vault: SecretVault, userId: string) {
  const config = ctx.db.get<{ encrypted_key: string }>(
    'SELECT encrypted_key FROM openai_gateway_config WHERE user_id=?',
    userId,
  );
  return readCredential(vault, config?.encrypted_key);
}

export function resolveGatewayKey(ctx: Context, vault: SecretVault, authorization?: string) {
  const token = /^Bearer (dsk_[\w-]{43})$/i.exec(authorization ?? '')?.[1];
  const row =
    token &&
    ctx.db.get<{ userId: string; encryptedKey: string | null }>(
      `SELECT k.user_id AS userId, COALESCE(c.encrypted_key,k.legacy_encrypted_key) AS encryptedKey
      FROM openai_gateway_keys k JOIN users u ON u.id=k.user_id
      LEFT JOIN openai_gateway_config c ON c.user_id=k.user_id
      WHERE k.key_hash=? AND u.active=1 AND u.role='admin'`,
      digest(token),
    );
  if (!row) throw new HttpError(401, '转发 Key 无效或已撤销');
  const apiKey = readCredential(vault, row.encryptedKey);
  if (!apiKey) throw new HttpError(503, '请在转发设置中配置 OpenAI API Key');
  return { userId: row.userId, apiKey };
}

export function createKeyRouter(ctx: Context, vault: SecretVault) {
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
    const userId = req.user!.id;
    const keys = ctx.db.all(
      `SELECT id,name,prefix,created_at AS createdAt FROM openai_gateway_keys
        WHERE user_id=? ORDER BY created_at DESC,id`,
      userId,
    );
    res.json({ configured: !!configuredKey(ctx, vault, userId), keys });
  });
  router.put(root + '/config', (req, res) => {
    const { apiKey } = z.strictObject({ apiKey: apiKeySchema }).parse(req.body);
    const userId = req.user!.id;
    ctx.db.transaction(() => {
      ctx.db.run(
        `INSERT INTO openai_gateway_config(user_id,encrypted_key) VALUES(?,?)
          ON CONFLICT(user_id) DO UPDATE SET encrypted_key=excluded.encrypted_key`,
        userId,
        vault.encrypt(apiKey),
      );
      ctx.db.run(
        'UPDATE openai_gateway_keys SET legacy_encrypted_key=NULL WHERE user_id=? AND legacy_encrypted_key IS NOT NULL',
        userId,
      );
    });
    res.json({ ok: true });
  });
  router.post(root + '/keys', (req, res) => {
    const { name } = z.strictObject({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const userId = req.user!.id;
    if (!configuredKey(ctx, vault, userId)) throw new HttpError(400, '请先配置 OpenAI API Key');
    const key = 'dsk_' + randomBytes(32).toString('base64url');
    ctx.db.run(
      'INSERT INTO openai_gateway_keys(id,user_id,name,prefix,key_hash,created_at) VALUES(?,?,?,?,?,?)',
      randomUUID(),
      userId,
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
