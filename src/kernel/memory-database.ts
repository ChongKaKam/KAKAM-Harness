import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { HttpError } from './http';
import type { MemoryDatabaseOptions } from './memory-config';

export const memoryTables = [
  'memory_schema_migrations',
  'memory_preferences',
  'memory_strategy_configs',
  'memory_items',
  'memory_sources',
  'memory_versions',
  'memory_embedding_spaces',
  'memory_embeddings',
  'memory_proposals',
  'memory_scope_state',
  'memory_selections',
  'memory_operations',
];
export const memoryMigrationVersion = 3;
export interface MemoryDatabaseHealth {
  configured: boolean;
  ready: boolean;
  error: string | null;
}
const connectionFailure = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  /^(ECONN|EPIPE|ETIMEDOUT|08|57P0)/.test(String(error.code));

/** Memory owns a separate PostgreSQL database; never runs schema changes in a request. */
export class MemoryDatabase {
  private pool?: Pool;
  private initialization: Promise<void>;
  private activeInitialization?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;
  private closed = false;
  private schema?: string;
  private options: MemoryDatabaseOptions;
  ready = false;
  error: string | null = null;
  constructor(databaseUrl?: string, options: MemoryDatabaseOptions = {}) {
    this.options = options;
    if (!databaseUrl) {
      this.error = '尚未配置 MEMORY_DATABASE_URL';
      this.initialization = Promise.resolve();
      return;
    }
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: options.poolMax ?? 5,
      application_name: options.applicationName ?? 'drift-space-memory',
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 12000,
    });
    this.pool.on('error', () => {
      this.disconnected();
    });
    this.initialization = this.initialize();
  }
  async initialized() {
    await this.initialization;
  }
  private initialize() {
    return (this.activeInitialization ??= this.prepare().finally(() => {
      this.activeInitialization = undefined;
    }));
  }
  private async prepare() {
    try {
      if (this.options.migrate === false) {
        const client = await this.pool!.connect();
        try {
          await this.validateSession(client);
          await this.validateStructure(client);
        } finally {
          client.release();
        }
      } else await this.migrate();
      if (this.closed) return;
      this.ready = true;
      this.error = null;
      this.retryDelay = 1000;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    } catch (error) {
      this.ready = false;
      this.error =
        error instanceof HttpError
          ? error.message
          : '记忆数据库未就绪，请检查连接、专属 schema、业务权限与已安装的 pgvector';
      this.scheduleRetry();
    }
  }
  private scheduleRetry() {
    if (this.closed || !this.pool || this.retryTimer || this.options.migrate === false) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      // Recovery is background lifecycle work, never a migration inside an HTTP request.
      this.initialization = this.initialize();
    }, this.retryDelay);
    this.retryTimer.unref();
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
  }
  private disconnected() {
    if (this.closed) return;
    this.ready = false;
    this.error = '记忆数据库连接失败，正在重新连接';
    this.scheduleRetry();
  }
  private async validateSession(client: PoolClient) {
    const row = (
      await client.query<{
        schema: string | null;
        schemas: string[];
        owner: string;
        user: string;
        writable: boolean;
        vector_schema: string | null;
        privileged: boolean;
      }>(
        `SELECT current_schema() AS schema,current_schemas(false) AS schemas,current_user AS "user",
      (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname=current_schema()) AS owner,
      has_schema_privilege(current_schema(),'USAGE') AND has_schema_privilege(current_schema(),'CREATE') AS writable,
      (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector') AS vector_schema,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged`,
      )
    ).rows[0];
    const expected = this.options.schema ?? this.schema;
    if (
      !row.schema ||
      !/^[a-z_][a-z0-9_]{0,62}$/.test(row.schema) ||
      (expected && row.schema !== expected)
    )
      throw new HttpError(503, '记忆数据库 search_path 与指定的业务 schema 不匹配，请由管理员核对');
    if (!row.schemas.includes('public') || row.vector_schema !== 'public')
      throw new HttpError(
        503,
        '请由管理员在当前业务库的 public schema 安装 pgvector，并保留 public 搜索路径',
      );
    if (!row.writable || (this.options.schema && row.schema !== 'public' && row.owner !== row.user))
      throw new HttpError(503, '记忆业务 schema 必须归应用账号所有，并授予 USAGE / CREATE 权限');
    if (this.options.schema && row.schema !== 'public' && row.privileged)
      throw new HttpError(503, '共享记忆数据库必须使用没有实例管理权限的专属应用账号');
    this.schema = row.schema;
  }
  private async validateStructure(client: PoolClient) {
    const row = (
      await client.query<{ version: number; tables: number; owned: boolean }>(
        `SELECT (SELECT max(version) FROM "${this.schema}".memory_schema_migrations) AS version,
      count(*)::integer AS tables,bool_and(tableowner=current_user) AS owned FROM pg_tables
      WHERE schemaname=$1 AND tablename=ANY($2::text[])`,
        [this.schema, memoryTables],
      )
    ).rows[0];
    if (row.version !== memoryMigrationVersion || row.tables !== memoryTables.length || !row.owned)
      throw new HttpError(503, '记忆数据库迁移版本、必要表或表归属不正确，请先执行应用账号迁移');
  }
  private async migrate() {
    const client = await this.pool!.connect();
    let locked = false;
    let began = false;
    try {
      await this.validateSession(client);
      await client.query(
        "SELECT pg_advisory_lock(hashtextextended(current_database()||':'||current_schema()||':memory-migrations',0))",
      );
      locked = true;
      await client.query('BEGIN');
      began = true;
      await client.query(`CREATE TABLE IF NOT EXISTS "${this.schema}".memory_schema_migrations (
        version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const result = await client.query(
        'SELECT version FROM memory_schema_migrations WHERE version=1',
      );
      if (!result.rowCount) {
        await client.query(`
          CREATE TABLE memory_preferences (
            namespace text NOT NULL, owner_id text NOT NULL,
            document jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY(namespace,owner_id)
          );
          CREATE TABLE memory_strategy_configs (
            namespace text NOT NULL, owner_id text NOT NULL, strategy_id text NOT NULL,
            version integer NOT NULL DEFAULT 1, document jsonb NOT NULL DEFAULT '{}',
            updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace,owner_id,strategy_id)
          );
          CREATE TABLE memory_items (
            namespace text NOT NULL, owner_id text NOT NULL, id uuid NOT NULL,
            scope text NOT NULL CHECK(scope IN ('user','group','session')), scope_id text NOT NULL DEFAULT '',
            kind text NOT NULL CHECK(kind IN ('profile','preference','instruction','fact','episode','summary','task')),
            content text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','review','deleted')),
            version integer NOT NULL DEFAULT 1, tags jsonb NOT NULL DEFAULT '[]', pinned boolean NOT NULL DEFAULT false,
            dedupe_key text NOT NULL, confirmed boolean NOT NULL DEFAULT false,
            index_status text NOT NULL DEFAULT 'pending',
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz, PRIMARY KEY(namespace,owner_id,id),
            UNIQUE(namespace,owner_id,scope,scope_id,kind,dedupe_key),
            CHECK((scope='user' AND scope_id='') OR (scope<>'user' AND scope_id<>''))
          );
          CREATE INDEX memory_items_scope ON memory_items(namespace,owner_id,scope,scope_id,status);
          CREATE TABLE memory_sources (
            namespace text NOT NULL, owner_id text NOT NULL, memory_id uuid NOT NULL,
            conversation_id text NOT NULL, message_id text NOT NULL, source_hash text NOT NULL,
            evidence text NOT NULL DEFAULT '', PRIMARY KEY(namespace,owner_id,memory_id,message_id),
            FOREIGN KEY(namespace,owner_id,memory_id) REFERENCES memory_items(namespace,owner_id,id) ON DELETE CASCADE
          );
          CREATE INDEX memory_sources_conversation ON memory_sources(namespace,owner_id,conversation_id,message_id);
          CREATE TABLE memory_versions (
            namespace text NOT NULL, owner_id text NOT NULL, memory_id uuid NOT NULL,
            version integer NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY(namespace,owner_id,memory_id,version),
            FOREIGN KEY(namespace,owner_id,memory_id) REFERENCES memory_items(namespace,owner_id,id) ON DELETE CASCADE
          );
          CREATE TABLE memory_embedding_spaces (
            namespace text NOT NULL, owner_id text NOT NULL, id uuid NOT NULL,
            model_id text NOT NULL, model_fingerprint text NOT NULL, dimensions integer NOT NULL CHECK(dimensions>0),
            state text NOT NULL DEFAULT 'building' CHECK(state IN ('building','active','retired')),
            created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace,owner_id,id),
            UNIQUE(namespace,owner_id,model_fingerprint,dimensions)
          );
          CREATE TABLE memory_embeddings (
            namespace text NOT NULL, owner_id text NOT NULL, memory_id uuid NOT NULL,
            space_id uuid NOT NULL, content_version integer NOT NULL, embedding public.vector NOT NULL,
            PRIMARY KEY(namespace,owner_id,memory_id,space_id),
            FOREIGN KEY(namespace,owner_id,memory_id) REFERENCES memory_items(namespace,owner_id,id) ON DELETE CASCADE,
            FOREIGN KEY(namespace,owner_id,space_id) REFERENCES memory_embedding_spaces(namespace,owner_id,id) ON DELETE CASCADE
          );
          CREATE INDEX memory_embeddings_space ON memory_embeddings(namespace,owner_id,space_id);
          CREATE TABLE memory_proposals (
            namespace text NOT NULL, owner_id text NOT NULL, id uuid NOT NULL, document jsonb NOT NULL,
            status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','invalidated')),
            dedupe_key text NOT NULL, memory_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY(namespace,owner_id,id), UNIQUE(namespace,owner_id,dedupe_key)
          );
          CREATE TABLE memory_scope_state (
            namespace text NOT NULL, owner_id text NOT NULL, scope text NOT NULL CHECK(scope IN ('group','session')),
            scope_id text NOT NULL, document jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
            updated_at timestamptz NOT NULL DEFAULT now(), last_activity_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY(namespace,owner_id,scope,scope_id)
          );
          CREATE TABLE memory_selections (
            namespace text NOT NULL, owner_id text NOT NULL, session_id text NOT NULL, memory_id uuid NOT NULL,
            mode text NOT NULL CHECK(mode IN ('priority','exclude')), PRIMARY KEY(namespace,owner_id,session_id,memory_id),
            FOREIGN KEY(namespace,owner_id,memory_id) REFERENCES memory_items(namespace,owner_id,id) ON DELETE CASCADE
          );
          CREATE TABLE memory_operations (
            namespace text NOT NULL, owner_id text NOT NULL, id uuid NOT NULL,
            kind text NOT NULL, status text NOT NULL DEFAULT 'running', strategy_id text NOT NULL,
            input jsonb NOT NULL DEFAULT '{}', result jsonb, error text,
            idempotency_key text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY(namespace,owner_id,id), UNIQUE(namespace,owner_id,kind,idempotency_key)
          );
          INSERT INTO memory_schema_migrations(version) VALUES(1);
        `);
      }
      const v2 = await client.query('SELECT version FROM memory_schema_migrations WHERE version=2');
      if (!v2.rowCount) {
        await client.query(`CREATE UNIQUE INDEX memory_embedding_spaces_one_active ON memory_embedding_spaces(namespace,owner_id) WHERE state='active';
          INSERT INTO memory_schema_migrations(version) VALUES(2)`);
      }
      const v3 = await client.query('SELECT version FROM memory_schema_migrations WHERE version=3');
      if (!v3.rowCount) {
        await client.query(`ALTER TABLE memory_items DROP CONSTRAINT memory_items_status_check;
          ALTER TABLE memory_items ADD CONSTRAINT memory_items_status_check CHECK(status IN ('active','pending','review','deleted'));
          ALTER TABLE memory_items ADD COLUMN admitted_at timestamptz;
          INSERT INTO memory_schema_migrations(version) VALUES(3)`);
      }
      await this.validateStructure(client);
      await client.query('COMMIT');
    } catch (error) {
      if (began) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (locked)
        await client
          .query(
            "SELECT pg_advisory_unlock(hashtextextended(current_database()||':'||current_schema()||':memory-migrations',0))",
          )
          .catch(() => {});
      client.release();
    }
  }
  async health(): Promise<MemoryDatabaseHealth> {
    await this.initialized();
    if (this.ready && this.pool && !this.closed) {
      let client: PoolClient | undefined;
      try {
        client = await this.pool.connect();
        await client.query('SELECT 1');
        await this.validateSession(client);
        await this.validateStructure(client);
      } catch (error) {
        this.disconnected();
        if (error instanceof HttpError) this.error = error.message;
      } finally {
        client?.release();
      }
    }
    return { configured: !!this.pool, ready: this.ready && !this.closed, error: this.error };
  }
  async describe() {
    const health = await this.health();
    if (!health.ready) throw new HttpError(503, health.error ?? '记忆数据库未就绪');
    return (
      await this
        .query(`SELECT current_database() AS database,current_user AS "user",current_schema() AS schema,
      current_setting('search_path') AS "searchPath",current_setting('application_name') AS "applicationName",
      (SELECT extversion FROM pg_extension WHERE extname='vector') AS "vectorVersion",
      (SELECT max(version) FROM memory_schema_migrations) AS "migrationVersion"`)
    ).rows[0];
  }
  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    await this.initialized();
    if (!this.ready || !this.pool) throw new HttpError(503, this.error ?? '记忆数据库未就绪');
    try {
      return await this.pool.query<T>(sql, values);
    } catch (error) {
      if (connectionFailure(error)) this.disconnected();
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, '记忆数据库操作失败，请稍后重试');
    }
  }
  /** Only database work belongs inside this callback. Model calls run outside it. */
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.initialized();
    if (!this.ready || !this.pool) throw new HttpError(503, this.error ?? '记忆数据库未就绪');
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      this.disconnected();
      throw new HttpError(503, '记忆数据库连接失败，请稍后重试');
    }
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      if (connectionFailure(error)) this.disconnected();
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, '记忆数据库操作失败，请稍后重试');
    } finally {
      client.release();
    }
  }
  async close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.initialized();
    this.ready = false;
    await this.pool?.end();
  }
}
