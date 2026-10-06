import { z } from 'zod';

export class MemoryConfigError extends Error {}

export const memoryEnvironmentSchema = z.object({
  MEMORY_DATABASE_URL: z
    .string()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['postgres:', 'postgresql:'].includes(url.protocol) &&
          !!url.hostname &&
          url.pathname.length > 1 &&
          !['host', 'hostaddr', 'port', 'user', 'database', 'dbname'].some((key) =>
            url.searchParams.has(key),
          )
        );
      } catch {
        return false;
      }
    }, 'MEMORY_DATABASE_URL 必须为包含库名的 PostgreSQL 地址，不能通过查询参数覆盖主机、端口、库名或账号')
    .optional(),
  MEMORY_NAMESPACE: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .default('drift-space'),
  MEMORY_DB_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .optional(),
  MEMORY_DB_POOL_MAX: z.coerce.number().int().min(1).max(16).default(5),
  MEMORY_DB_APPLICATION_NAME: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,63}$/)
    .default('drift-space-memory'),
  MEMORY_DB_HOST: z.string().min(1).optional(),
  MEMORY_DB_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  MEMORY_DB_NAME: z.string().min(1).optional(),
  MEMORY_DB_USER: z.string().min(1).optional(),
});

export interface MemoryDatabaseOptions {
  /** Verify the administrator-assigned search_path; never silently choose public instead. */
  schema?: string;
  poolMax?: number;
  applicationName?: string;
  /** Check mode does not create or modify any database object. */
  migrate?: boolean;
}

export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env) {
  const values = memoryEnvironmentSchema.parse(env);
  const metadata = [
    values.MEMORY_DB_HOST,
    values.MEMORY_DB_PORT,
    values.MEMORY_DB_NAME,
    values.MEMORY_DB_USER,
  ];
  if (metadata.some((value) => value !== undefined)) {
    let matches = false;
    try {
      const url = new URL(values.MEMORY_DATABASE_URL!);
      matches =
        metadata.every((value) => value !== undefined) &&
        url.hostname === values.MEMORY_DB_HOST &&
        Number(url.port || 5432) === values.MEMORY_DB_PORT &&
        decodeURIComponent(url.pathname.slice(1)) === values.MEMORY_DB_NAME &&
        decodeURIComponent(url.username) === values.MEMORY_DB_USER;
    } catch {
      /* Report configuration names only, never the URL. */
    }
    if (!matches)
      throw new MemoryConfigError(
        'Memory 的四项 MEMORY_DB_HOST / PORT / NAME / USER 必须完整且与 MEMORY_DATABASE_URL 一致',
      );
  }
  return {
    databaseUrl: values.MEMORY_DATABASE_URL,
    namespace: values.MEMORY_NAMESPACE,
    databaseOptions: {
      schema: values.MEMORY_DB_SCHEMA,
      poolMax: values.MEMORY_DB_POOL_MAX,
      applicationName: values.MEMORY_DB_APPLICATION_NAME,
    },
  };
}
