import type { Context } from 'cordis';
import { SecretVault } from '../../kernel/crypto';
import { createKeyRouter } from './keys';
import { createProxyRouter } from './proxy';
import { manifest } from './manifest';
export { manifest };

export function createGatewayFeature(secret: string, maxConcurrentRequests?: number) {
  return {
    name: manifest.id,
    inject: ['db', 'http', 'kernel'],
    apply(ctx: Context) {
      const vault = new SecretVault(secret);
      const admin = createKeyRouter(ctx, vault);
      const proxy = createProxyRouter(ctx, vault, { maxConcurrentRequests });
      ctx.effect(() => ctx.http.register(admin));
      ctx.effect(() => ctx.http.register(proxy));
    },
  };
}
