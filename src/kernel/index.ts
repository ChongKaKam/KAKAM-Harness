import './context';
import { JevAdapter } from '../adapters/jev';
import { Context, ScopeStatus } from 'cordis';
import type { FeatureManifest } from '../shared/types';
import { Database } from './database';
import { HttpService, HttpError } from './http';
import { AdapterRegistry } from '../adapters/registry';
import { AnthropicMessagesAdapter } from '../adapters/anthropic-messages';
import { OpenAICompatibleAdapter } from '../adapters/openai-compatible';
export class KHKernel {
  readonly ctx = new Context();
  private errors: unknown[] = [];
  private transition: Promise<void> = Promise.resolve();
  private shutdownHandlers = new Set<() => Promise<unknown>>();
  private stopping?: Promise<void>;
  private features = new Map<
    string,
    {
      manifest: FeatureManifest;
      server: { name: string; inject: string[]; apply(ctx: Context): void | Promise<void> };
      dispose?: () => void;
    }
  >();
  constructor(dataDir: string) {
    this.ctx.on('internal/error', (error) => {
      this.errors.push(error);
    });
    this.ctx.provide('kernel', this);
    this.ctx.plugin(Database, dataDir);
    this.ctx.plugin(HttpService);
    this.ctx.plugin(AdapterRegistry);
    this.ctx.plugin({
      name: 'adapter.openai-compatible',
      inject: ['adapters'],
      apply(ctx) {
        ctx.effect(() => ctx.adapters.register('jev', new JevAdapter()));
        ctx.effect(() => ctx.adapters.register('openai-compatible', new OpenAICompatibleAdapter()));
        ctx.effect(() =>
          ctx.adapters.register('anthropic-messages', new AnthropicMessagesAdapter()),
        );
      },
    });
  }
  async register(
    manifest: FeatureManifest,
    server: { name: string; inject: string[]; apply(ctx: Context): void | Promise<void> },
  ) {
    if (this.features.has(manifest.id)) throw new Error(`Duplicate feature: ${manifest.id}`);
    this.features.set(manifest.id, { manifest, server });
    const saved = this.ctx.db.get<{ value: string }>(
      'SELECT value FROM settings WHERE key=?',
      `feature:${manifest.id}`,
    );
    if (manifest.kind === 'core' || saved?.value !== 'false') await this.toggle(manifest.id, true);
  }
  toggle(id: string, enabled: boolean): Promise<void> {
    const task = this.transition.then(() => this.applyToggle(id, enabled));
    this.transition = task.catch(() => {});
    return task;
  }
  private async applyToggle(id: string, enabled: boolean) {
    const entry = this.features.get(id);
    if (!entry) throw new HttpError(404, '功能不存在');
    if (!enabled && entry.manifest.kind === 'core') throw new HttpError(400, '基础能力不能停用');
    if (enabled && !entry.dispose) {
      const scope = this.ctx.plugin(entry.server);
      await this.ctx.events.flush();
      if (this.errors.length) {
        scope.dispose();
        throw this.errors.shift();
      }
      if (scope.runtime.status !== ScopeStatus.ACTIVE) {
        scope.dispose();
        throw scope.runtime.error ?? new Error(`Feature failed to activate: ${id}`);
      }
      entry.dispose = () => {
        scope.dispose();
      };
    }
    if (!enabled && entry.dispose) {
      entry.dispose();
      entry.dispose = undefined;
    }
    this.ctx.db.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      `feature:${id}`,
      String(enabled),
    );
  }
  manifests(admin: boolean) {
    return [...this.features.values()]
      .filter((e) => admin || !e.manifest.adminOnly)
      .map((e) => ({ ...e.manifest, enabled: !!e.dispose }));
  }
  onShutdown(handler: () => Promise<unknown>) {
    this.shutdownHandlers.add(handler);
    return () => {
      this.shutdownHandlers.delete(handler);
    };
  }
  stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      // Let features finish writing their interrupted jobs before the DB service closes.
      await Promise.allSettled([...this.shutdownHandlers].map((handler) => handler()));
      await this.ctx.stop();
    })());
  }
}
