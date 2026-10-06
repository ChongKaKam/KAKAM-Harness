import express from 'express';
import { APP_VERSION } from '../shared/version';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { KHKernel } from '../kernel';
import { HttpError, requireUser, requireAdmin } from '../kernel/http';
import type { Config } from './config';
import { authFeature, manifest as auth } from '../features/auth/server';
import * as users from '../features/users/server';
import { modelsFeature, manifest as models } from '../features/models/server';
import * as extensions from '../features/extensions/server';
import * as search from '../features/search/server';
import * as chat from '../features/chat/server';
import * as usage from '../features/usage/server';
import * as prompts from '../features/prompts/server';
import * as preferences from '../features/preferences/server';
import * as contextManager from '../features/context-manager/server';
import { createMemoryFeature, manifest as memory } from '../features/memory/server';
export async function createApp(config: Config) {
  const kernel = new KHKernel(config.dataDir);
  try {
    await kernel.register(auth, authFeature(config));
    await kernel.register(users.manifest, users.server);
    await kernel.register(models, modelsFeature(config.secret));
    await kernel.register(extensions.manifest, extensions.server);
    await kernel.register(search.manifest, search.server);
    await kernel.register(chat.manifest, chat.server);
    await kernel.register(usage.manifest, usage.server);
    await kernel.register(prompts.manifest, prompts.server);
    await kernel.register(preferences.manifest, preferences.server);
    await kernel.register(contextManager.manifest, contextManager.server);
    await kernel.register(
      memory,
      createMemoryFeature({
        databaseUrl: config.memoryDatabaseUrl,
        namespace: config.memoryNamespace ?? 'drift-space',
        databaseOptions: config.memoryDatabaseOptions,
      }),
    );
    await kernel.ctx.start();
  } catch (error) {
    await kernel.stop();
    throw error;
  }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameSrc: ["'none'"],
          upgradeInsecureRequests: config.secureCookies ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const allowed = config.publicOrigin ?? `${req.protocol}://${req.get('host')}`;
      if (req.get('origin') && req.get('origin') !== allowed)
        return next(new HttpError(403, '请求来源不被允许'));
      if (!req.is('application/json')) return next(new HttpError(415, '请求必须为 JSON'));
    }
    next();
  });
  app.use(express.json({ limit: '29mb' }));
  app.use(cookieParser());
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: APP_VERSION }));
  app.get('/api/health/memory', async (_req, res) => {
    if (!kernel.manifests(false).some((feature) => feature.id === 'memory' && feature.enabled)) {
      res.json({ status: 'disabled', configured: !!config.memoryDatabaseUrl, ready: false });
      return;
    }
    const health = await kernel.ctx.memory.repository.health();
    res.status(health.configured && !health.ready ? 503 : 200).json({
      status: !health.configured ? 'unconfigured' : health.ready ? 'ok' : 'unavailable',
      ...health,
    });
  });
  app.use('/api', (req, _res, next) => {
    req.user = kernel.ctx.auth.resolve(req.cookies.kh_session);
    next();
  });
  app.get('/api/features', requireUser, (req, res) =>
    res.json(kernel.manifests(req.user!.role === 'admin')),
  );
  app.patch('/api/features/:id', requireAdmin, async (req, res) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await kernel.toggle(String(req.params.id), enabled);
    res.json({ ok: true });
  });
  app.use('/api', kernel.ctx.http.handle);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, '接口不存在或功能未启用')));
  if (config.clientDir && existsSync(resolve(config.clientDir, 'index.html'))) {
    app.use(express.static(resolve(config.clientDir), { index: false }));
    app.get('/{*path}', (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(resolve(config.clientDir!, 'index.html'));
    });
  }
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '输入无效' });
        return;
      }
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 413 || error.status === 400)
      ) {
        res.status(Number(error.status)).json({ error: '请求内容无效或超过大小限制' });
        return;
      }
      console.error('Request failed:', error instanceof Error ? error.name : 'unknown');
      res.status(500).json({ error: '服务器处理失败，请稍后重试' });
    },
  );
  return { app, kernel };
}
