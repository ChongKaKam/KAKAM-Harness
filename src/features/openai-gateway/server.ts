import type { Context } from 'cordis';
import { createKeyRouter } from './keys';
import { createProxyRouter } from './proxy';
import { manifest } from './manifest';
export { manifest };

export function createGatewayFeature(maxConcurrentRequests?: number) {
  return {
    name: manifest.id,
    inject: ['db', 'http', 'models', 'kernel'],
    apply(ctx: Context) {
      const admin = createKeyRouter(ctx);
      const proxy = createProxyRouter(ctx, { maxConcurrentRequests });
      ctx.effect(() => ctx.http.register(admin));
      ctx.effect(() => ctx.http.register(proxy));
    },
  };
}
