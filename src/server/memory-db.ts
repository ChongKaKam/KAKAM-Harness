import { ZodError } from 'zod';
import { MemoryConfigError, readMemoryConfig } from '../kernel/memory-config';
import { MemoryDatabase } from '../kernel/memory-database';
import { HttpError } from '../kernel/http';

let database: MemoryDatabase | undefined;
try {
  const mode = process.argv[2];
  if (mode !== 'migrate' && mode !== 'check')
    throw new MemoryConfigError('用法：memory-db.js migrate|check');
  const config = readMemoryConfig();
  if (!config.databaseUrl) throw new MemoryConfigError('尚未配置 MEMORY_DATABASE_URL');
  database = new MemoryDatabase(config.databaseUrl, {
    ...config.databaseOptions,
    migrate: mode === 'migrate',
  });
  await database.initialized();
  console.log(JSON.stringify({ mode, ...(await database.describe()) }));
} catch (error) {
  // Never serialize driver errors, connection URLs or environment values.
  const message =
    error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : error instanceof HttpError || error instanceof MemoryConfigError
        ? error.message
        : '记忆数据库检查失败';
  console.error(message);
  process.exitCode = 1;
} finally {
  await database?.close();
}
