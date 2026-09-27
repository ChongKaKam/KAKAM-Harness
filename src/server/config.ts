import { z } from 'zod';
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  secret: string;
  publicOrigin?: string;
  secureCookies: boolean;
  trustProxy: number;
  clientDir?: string;
}
export function readConfig(): Config {
  const e = z
    .object({
      PORT: z.coerce.number().int().min(1).max(65535).default(3600),
      HOST: z.string().default('0.0.0.0'),
      DATA_DIR: z.string().default('./data'),
      APP_SECRET: z.string().min(32, 'APP_SECRET 至少需要 32 个字符'),
      PUBLIC_ORIGIN: z.url().optional(),
      COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
      TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    })
    .parse(process.env);
  return {
    port: e.PORT,
    host: e.HOST,
    dataDir: e.DATA_DIR,
    secret: e.APP_SECRET,
    publicOrigin: e.PUBLIC_ORIGIN ? new URL(e.PUBLIC_ORIGIN).origin : undefined,
    secureCookies: e.COOKIE_SECURE === 'true',
    trustProxy: e.TRUST_PROXY,
    clientDir: 'dist/client',
  };
}
