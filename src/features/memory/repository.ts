import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { MemoryDatabase, type MemoryDatabaseHealth } from '../../kernel/memory-database';
import { HttpError } from '../../kernel/http';
import type {
  MemoryItem,
  MemorySource,
  MemoryScope,
  MemoryPreferences,
  DefaultMemoryConfig,
  MemoryProposal,
  MemoryOperation,
  MemoryScopeState,
  MemoryIndexSpace,
} from '../../shared/memory';
import type { MemoryInput } from './config';

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const contentKey = (text: string) =>
  digest(text.normalize('NFKC').replace(/\s+/g, ' ').trim());
type Row = Record<string, any>;
function item(row: Row): MemoryItem {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id || null,
    kind: row.kind,
    content: row.content,
    status: row.status,
    version: row.version,
    tags: row.tags,
    pinned: row.pinned,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    sources: row.sources ?? [],
    indexStatus: row.index_status,
    ...(row.similarity === undefined ? {} : { similarity: Number(row.similarity) }),
    ...(row.preferred === 1 ? { selection: 'prefer' as const } : {}),
  };
}
function proposal(row: Row): MemoryProposal {
  return {
    ...row.document,
    id: row.id,
    state: row.status === 'accepted' ? 'approved' : row.status,
    memoryId: row.memory_id,
    createdAt: iso(row.created_at),
  };
}
function operation(row: Row): MemoryOperation {
  return {
    id: row.id,
    type: row.kind,
    state: row.status,
    createdAt: iso(row.created_at),
    finishedAt: ['complete', 'error', 'cancelled', 'applied'].includes(row.status)
      ? iso(row.updated_at)
      : null,
    error: row.error,
    facts: { ...row.input, ...(row.result ?? {}), strategyId: row.strategy_id },
  };
}
function space(row: Row): MemoryIndexSpace {
  return {
    id: row.id,
    modelId: row.model_id,
    dimensions: row.dimensions,
    fingerprint: row.model_fingerprint,
    state: row.state,
    createdAt: iso(row.created_at),
    indexed: Number(row.indexed ?? 0),
    total: Number(row.total ?? 0),
  };
}
const sourceSelect = `COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'conversationId',s.conversation_id,'messageId',s.message_id,'hash',s.source_hash,'evidence',s.evidence))
  FROM memory_sources s WHERE s.namespace=m.namespace AND s.owner_id=m.owner_id AND s.memory_id=m.id),'[]') AS sources`;
export interface MemoryListFilter {
  scope?: MemoryScope;
  scopeId?: string;
  query?: string;
  status?: string;
}
export interface SavedStrategyConfig {
  version: number;
  config: Record<string, unknown>;
}
export interface RepositoryOperation {
  operation: MemoryOperation;
  created: boolean;
}
/** Manager depends on this interface so isolated tests can supply a repository without production data. */
export interface MemoryRepository {
  initialized(): Promise<void>;
  health(): Promise<MemoryDatabaseHealth>;
  ready: boolean;
  error: string | null;
  close(): Promise<void>;
  preferences(owner: string): Promise<Partial<MemoryPreferences>>;
  savePreferences(owner: string, value: MemoryPreferences): Promise<void>;
  config(owner: string, strategy: string): Promise<SavedStrategyConfig | null>;
  saveConfig(
    owner: string,
    strategy: string,
    value: Record<string, unknown>,
    version: number,
  ): Promise<SavedStrategyConfig>;
  list(owner: string, filter?: MemoryListFilter): Promise<MemoryItem[]>;
  get(owner: string, id: string): Promise<MemoryItem>;
  create(
    owner: string,
    input: MemoryInput,
    sources: MemorySource[],
    confirmed: boolean,
  ): Promise<MemoryItem>;
  update(owner: string, id: string, version: number, input: MemoryInput): Promise<MemoryItem>;
  delete(owner: string, id: string): Promise<void>;
  scopeItems(owner: string, scope: MemoryScope, scopeId: string): Promise<MemoryItem[]>;
  candidates(
    owner: string,
    vector: number[],
    spaceId: string,
    sessionId: string | null,
    groupId: string | null,
    limit: number,
    threshold: number,
  ): Promise<MemoryItem[]>;
  spaces(owner: string): Promise<MemoryIndexSpace[]>;
  ensureSpace(
    owner: string,
    modelId: string,
    fingerprint: string,
    dimensions: number,
  ): Promise<MemoryIndexSpace>;
  activateSpace(owner: string, id: string): Promise<void>;
  storeVector(
    owner: string,
    id: string,
    version: number,
    spaceId: string,
    vector: number[],
  ): Promise<boolean>;
  setIndexStatus(owner: string, id: string, status: string): Promise<void>;
  unindexed(owner: string, spaceId: string): Promise<MemoryItem[]>;
  proposals(owner: string, state?: string): Promise<MemoryProposal[]>;
  getProposal(owner: string, id: string): Promise<MemoryProposal>;
  saveProposal(
    owner: string,
    value: Omit<MemoryProposal, 'id' | 'state' | 'createdAt'>,
  ): Promise<MemoryProposal>;
  decision(
    owner: string,
    id: string,
    state: 'accepted' | 'rejected',
    memoryId?: string,
  ): Promise<void>;
  decideProposal(owner: string, id: string, approve: boolean): Promise<MemoryItem | null>;
  scopeState(owner: string, scope: 'group' | 'session', id: string): Promise<MemoryScopeState>;
  saveScopeState(
    owner: string,
    scope: 'group' | 'session',
    id: string,
    summary: string,
    selections: Record<string, 'prefer' | 'exclude'>,
    version: number,
  ): Promise<MemoryScopeState>;
  touch(owner: string, sessionId: string, groupId: string | null): Promise<void>;
  beginOperation(
    owner: string,
    kind: string,
    strategy: string,
    input: Record<string, unknown>,
    key?: string,
  ): Promise<RepositoryOperation>;
  finishOperation(
    owner: string,
    id: string,
    state: MemoryOperation['state'],
    result?: Record<string, unknown>,
    error?: string,
  ): Promise<void>;
  operations(
    owner: string,
    conversationId?: string,
    messageId?: string,
  ): Promise<MemoryOperation[]>;
  getOperation(owner: string, id: string): Promise<MemoryOperation>;
  interruptOperations(): Promise<void>;
  invalidate(owner: string, conversationId: string, messageId: string): Promise<string[]>;
  detachConversation(owner: string, conversationId: string): Promise<void>;
  scopeRows(owner: string): Promise<{ scope: 'group' | 'session'; id: string }[]>;
  sourceRows(owner: string): Promise<MemorySource[]>;
  removeScopeData(owner: string, scope: 'group' | 'session', id: string): Promise<void>;
  expired(
    retentionDays: { group: number; session: number },
    owner?: string,
  ): Promise<{ owner: string; id: string }[]>;
  expiredScopes(
    retentionDays: { group: number; session: number },
    owner?: string,
  ): Promise<{ owner: string; scope: 'group' | 'session'; id: string }[]>;
}

export class PgMemoryRepository implements MemoryRepository {
  constructor(
    private db: MemoryDatabase,
    readonly namespace = 'drift-space',
  ) {}
  get ready() {
    return this.db.ready;
  }
  get error() {
    return this.db.error;
  }
  initialized() {
    return this.db.initialized();
  }
  health() {
    return this.db.health();
  }
  close() {
    return this.db.close();
  }
  private query(sql: string, owner: string, values: unknown[] = []) {
    return this.db.query<Row>(sql, [this.namespace, owner, ...values]);
  }
  async preferences(owner: string) {
    return (
      (
        await this.query(
          'SELECT document FROM memory_preferences WHERE namespace=$1 AND owner_id=$2',
          owner,
        )
      ).rows[0]?.document ?? {}
    );
  }
  async savePreferences(owner: string, value: MemoryPreferences) {
    await this.query(
      `INSERT INTO memory_preferences(namespace,owner_id,document) VALUES($1,$2,$3)
      ON CONFLICT(namespace,owner_id) DO UPDATE SET document=excluded.document,updated_at=now()`,
      owner,
      [JSON.stringify(value)],
    );
  }
  async config(owner: string, strategy: string): Promise<SavedStrategyConfig | null> {
    const row = (
      await this.query(
        'SELECT version,document FROM memory_strategy_configs WHERE namespace=$1 AND owner_id=$2 AND strategy_id=$3',
        owner,
        [strategy],
      )
    ).rows[0];
    return row ? { version: row.version, config: row.document } : null;
  }
  async saveConfig(
    owner: string,
    strategy: string,
    value: Record<string, unknown>,
    version: number,
  ) {
    const row = (
      await this.query(
        `INSERT INTO memory_strategy_configs(namespace,owner_id,strategy_id,version,document)
      SELECT $1,$2,$3,1,$4 WHERE $5=0
      ON CONFLICT(namespace,owner_id,strategy_id) DO NOTHING RETURNING version,document`,
        owner,
        [strategy, JSON.stringify(value), version],
      )
    ).rows[0];
    if (row) return { version: row.version, config: row.document };
    const updated = (
      await this.query(
        `UPDATE memory_strategy_configs SET version=version+1,document=$4,updated_at=now()
      WHERE namespace=$1 AND owner_id=$2 AND strategy_id=$3 AND version=$5 RETURNING version,document`,
        owner,
        [strategy, JSON.stringify(value), version],
      )
    ).rows[0];
    if (!updated) throw new HttpError(409, '策略设置已改变，请刷新后重试');
    return { version: updated.version, config: updated.document };
  }
  async list(owner: string, filter: MemoryListFilter = {}) {
    const result = await this.query(
      `SELECT m.*,${sourceSelect} FROM memory_items m
      WHERE namespace=$1 AND owner_id=$2 AND status<> 'deleted'
        AND ($3::text IS NULL OR scope=$3) AND ($4::text IS NULL OR scope_id=$4)
        AND ($5::text IS NULL OR content ILIKE '%'||$5||'%') AND ($6::text IS NULL OR status=$6)
      ORDER BY pinned DESC,updated_at DESC LIMIT 200`,
      owner,
      [filter.scope ?? null, filter.scopeId ?? null, filter.query ?? null, filter.status ?? null],
    );
    return result.rows.map(item);
  }
  async get(owner: string, id: string) {
    const row = (
      await this.query(
        `SELECT m.*,${sourceSelect} FROM memory_items m WHERE namespace=$1 AND owner_id=$2 AND id=$3 AND status<>'deleted'`,
        owner,
        [id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, '记忆不存在');
    return item(row);
  }
  private async sources(client: PoolClient, owner: string, id: string, sources: MemorySource[]) {
    for (const source of sources)
      await client.query(
        `INSERT INTO memory_sources(namespace,owner_id,memory_id,conversation_id,message_id,source_hash,evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(namespace,owner_id,memory_id,message_id) DO NOTHING`,
        [
          this.namespace,
          owner,
          id,
          source.conversationId,
          source.messageId,
          source.hash,
          source.evidence ?? '',
        ],
      );
  }
  async create(owner: string, input: MemoryInput, sources: MemorySource[], confirmed: boolean) {
    const id = await this.db.transaction(async (client) => {
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO memory_items(namespace,owner_id,id,scope,scope_id,kind,content,tags,pinned,expires_at,dedupe_key,confirmed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(namespace,owner_id,scope,scope_id,kind,dedupe_key) DO NOTHING RETURNING id`,
        [
          this.namespace,
          owner,
          id,
          input.scope,
          input.scopeId ?? '',
          input.kind,
          input.content,
          JSON.stringify(input.tags),
          input.pinned,
          input.expiresAt,
          contentKey(input.content),
          confirmed,
        ],
      );
      if (!result.rowCount) {
        const existing = (
          await client.query(
            `SELECT id,status FROM memory_items WHERE namespace=$1 AND owner_id=$2 AND scope=$3 AND scope_id=$4 AND kind=$5 AND dedupe_key=$6`,
            [
              this.namespace,
              owner,
              input.scope,
              input.scopeId ?? '',
              input.kind,
              contentKey(input.content),
            ],
          )
        ).rows[0];
        if (existing.status === 'deleted')
          throw new HttpError(409, '该内容已删除；删除墓碑阻止重复保存');
        await this.sources(client, owner, existing.id, sources);
        return existing.id as string;
      }
      await this.sources(client, owner, id, sources);
      return id;
    });
    return this.get(owner, id);
  }
  async update(owner: string, id: string, version: number, input: MemoryInput) {
    await this.db.transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT * FROM memory_items WHERE namespace=$1 AND owner_id=$2 AND id=$3 AND status<>'deleted' FOR UPDATE`,
          [this.namespace, owner, id],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, '记忆不存在');
      if (row.version !== version) throw new HttpError(409, '记忆已改变，请刷新后重试');
      const duplicate = (
        await client.query(
          `SELECT id FROM memory_items WHERE namespace=$1 AND owner_id=$2 AND scope=$3 AND scope_id=$4 AND kind=$5 AND dedupe_key=$6 AND id<>$7`,
          [
            this.namespace,
            owner,
            row.scope,
            row.scope_id,
            input.kind,
            contentKey(input.content),
            id,
          ],
        )
      ).rows[0];
      if (duplicate) throw new HttpError(409, '该范围已有相同记忆或删除墓碑');
      await client.query(
        `INSERT INTO memory_versions(namespace,owner_id,memory_id,version,document) VALUES($1,$2,$3,$4,$5)`,
        [this.namespace, owner, id, version, JSON.stringify(item(row))],
      );
      await client.query(
        `UPDATE memory_items SET content=$4,kind=$5,tags=$6,pinned=$7,expires_at=$8,dedupe_key=$9,
        version=version+1,updated_at=now(),index_status='pending',status='active',confirmed=true
        WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
        [
          this.namespace,
          owner,
          id,
          input.content,
          input.kind,
          JSON.stringify(input.tags),
          input.pinned,
          input.expiresAt,
          contentKey(input.content),
        ],
      );
      await client.query(
        'DELETE FROM memory_embeddings WHERE namespace=$1 AND owner_id=$2 AND memory_id=$3',
        [this.namespace, owner, id],
      );
      if (row.status === 'review')
        await client.query(
          'DELETE FROM memory_sources WHERE namespace=$1 AND owner_id=$2 AND memory_id=$3',
          [this.namespace, owner, id],
        );
    });
    return this.get(owner, id);
  }
  async delete(owner: string, id: string) {
    await this.db.transaction(async (client) => {
      const original = (
        await client.query(
          `SELECT content,scope,scope_id,kind FROM memory_items WHERE namespace=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`,
          [this.namespace, owner, id],
        )
      ).rows[0];
      const saved = await client.query(
        `UPDATE memory_items SET content='',tags='[]',status='deleted',version=version+1,updated_at=now(),index_status='pending'
        WHERE namespace=$1 AND owner_id=$2 AND id=$3 AND status<>'deleted' RETURNING id`,
        [this.namespace, owner, id],
      );
      if (!saved.rowCount) throw new HttpError(404, '记忆不存在');
      const historical = (
        await client.query(
          `SELECT document->>'content' AS content FROM memory_versions WHERE namespace=$1 AND owner_id=$2 AND memory_id=$3`,
          [this.namespace, owner, id],
        )
      ).rows.map((x) => String(x.content));
      for (const table of [
        'memory_embeddings',
        'memory_sources',
        'memory_versions',
        'memory_selections',
      ])
        await client.query(
          `DELETE FROM ${table} WHERE namespace=$1 AND owner_id=$2 AND memory_id=$3`,
          [this.namespace, owner, id],
        );
      await client.query(
        `DELETE FROM memory_proposals WHERE namespace=$1 AND owner_id=$2 AND (memory_id=$3 OR
          (document->>'scope'=$4 AND COALESCE(document->>'scopeId','')=$5 AND document->>'kind'=$6 AND document->>'content'=ANY($7::text[])))`,
        [
          this.namespace,
          owner,
          id,
          original.scope,
          original.scope_id,
          original.kind,
          [original.content, ...historical],
        ],
      );
      // Operation payloads contain IDs and counters, but no saved memory text.
    });
  }
  async scopeItems(owner: string, scope: MemoryScope, scopeId: string) {
    return (
      await this.query(
        `SELECT m.*,${sourceSelect} FROM memory_items m WHERE namespace=$1 AND owner_id=$2 AND scope=$3 AND scope_id=$4 AND status<>'deleted'`,
        owner,
        [scope, scopeId],
      )
    ).rows.map(item);
  }
  async candidates(
    owner: string,
    vector: number[],
    spaceId: string,
    sessionId: string | null,
    groupId: string | null,
    limit: number,
    threshold: number,
  ) {
    const result = await this.query(
      `SELECT m.*,${sourceSelect}, 1-(e.embedding <=> $4::vector) AS similarity,
      CASE WHEN sel.mode='priority' THEN 1 ELSE 0 END AS preferred
      FROM memory_items m JOIN memory_embeddings e ON e.namespace=m.namespace AND e.owner_id=m.owner_id AND e.memory_id=m.id AND e.content_version=m.version
      LEFT JOIN memory_selections sel ON sel.namespace=m.namespace AND sel.owner_id=m.owner_id AND sel.memory_id=m.id AND sel.session_id=$5
      WHERE m.namespace=$1 AND m.owner_id=$2 AND e.space_id=$3 AND m.status='active'
        AND (m.expires_at IS NULL OR m.expires_at>now()) AND COALESCE(sel.mode,'')<>'exclude'
        AND (m.scope='user' OR (m.scope='session' AND m.scope_id=$5) OR (m.scope='group' AND m.scope_id=$6))
        AND (m.pinned OR sel.mode='priority' OR 1-(e.embedding <=> $4::vector)>=$8)
      ORDER BY preferred DESC,m.pinned DESC,e.embedding <=> $4::vector LIMIT $7`,
      owner,
      [spaceId, JSON.stringify(vector), sessionId, groupId, limit, threshold],
    );
    return result.rows.map(item);
  }
  async spaces(owner: string) {
    const rows = await this.query(
      `SELECT s.*, (SELECT count(*) FROM memory_embeddings e JOIN memory_items m ON m.namespace=e.namespace AND m.owner_id=e.owner_id AND m.id=e.memory_id AND m.version=e.content_version
      WHERE e.namespace=s.namespace AND e.owner_id=s.owner_id AND e.space_id=s.id AND m.status='active') AS indexed,
      (SELECT count(*) FROM memory_items m WHERE m.namespace=s.namespace AND m.owner_id=s.owner_id AND m.status='active' AND (m.expires_at IS NULL OR m.expires_at>now())) AS total
      FROM memory_embedding_spaces s WHERE namespace=$1 AND owner_id=$2 ORDER BY created_at DESC`,
      owner,
    );
    return rows.rows.map(space);
  }
  async ensureSpace(owner: string, modelId: string, fingerprint: string, dimensions: number) {
    const row = (
      await this.query(
        `INSERT INTO memory_embedding_spaces(namespace,owner_id,id,model_id,model_fingerprint,dimensions)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,owner_id,model_fingerprint,dimensions)
      DO UPDATE SET model_id=excluded.model_id RETURNING *`,
        owner,
        [randomUUID(), modelId, fingerprint, dimensions],
      )
    ).rows[0];
    return space(row);
  }
  async activateSpace(owner: string, id: string) {
    await this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${this.namespace}:${owner}:space`,
      ]);
      await client.query(
        `UPDATE memory_embedding_spaces SET state='retired' WHERE namespace=$1 AND owner_id=$2 AND state='active' AND id<>$3`,
        [this.namespace, owner, id],
      );
      await client.query(
        `UPDATE memory_embedding_spaces SET state='active' WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
        [this.namespace, owner, id],
      );
    });
  }
  async storeVector(owner: string, id: string, version: number, spaceId: string, vector: number[]) {
    return this.db.transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT version,status FROM memory_items WHERE namespace=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`,
          [this.namespace, owner, id],
        )
      ).rows[0];
      if (!row || row.version !== version || row.status !== 'active') return false;
      const savedSpace = (
        await client.query(
          `SELECT dimensions FROM memory_embedding_spaces WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
          [this.namespace, owner, spaceId],
        )
      ).rows[0];
      if (
        !savedSpace ||
        vector.length !== savedSpace.dimensions ||
        !vector.every(Number.isFinite) ||
        !vector.some((x) => x !== 0)
      )
        throw new HttpError(400, '向量维度或数值无效');
      await client.query(
        `INSERT INTO memory_embeddings(namespace,owner_id,memory_id,space_id,content_version,embedding)
        VALUES($1,$2,$3,$4,$5,$6::vector) ON CONFLICT(namespace,owner_id,memory_id,space_id)
        DO UPDATE SET content_version=excluded.content_version,embedding=excluded.embedding`,
        [this.namespace, owner, id, spaceId, version, JSON.stringify(vector)],
      );
      await client.query(
        `UPDATE memory_items SET index_status='ready' WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
        [this.namespace, owner, id],
      );
      return true;
    });
  }
  async setIndexStatus(owner: string, id: string, status: string) {
    await this.query(
      `UPDATE memory_items SET index_status=$4 WHERE namespace=$1 AND owner_id=$2 AND id=$3 AND status<>'deleted'`,
      owner,
      [id, status],
    );
  }
  async unindexed(owner: string, spaceId: string) {
    return (
      await this.query(
        `SELECT m.*,${sourceSelect} FROM memory_items m
      WHERE namespace=$1 AND owner_id=$2 AND status='active' AND (expires_at IS NULL OR expires_at>now())
        AND NOT EXISTS(SELECT 1 FROM memory_embeddings e WHERE e.namespace=m.namespace AND e.owner_id=m.owner_id AND e.memory_id=m.id AND e.space_id=$3 AND e.content_version=m.version)
      ORDER BY m.created_at LIMIT 100`,
        owner,
        [spaceId],
      )
    ).rows.map(item);
  }
  async proposals(owner: string, state = 'pending') {
    const status = state === 'approved' ? 'accepted' : state;
    return (
      await this.query(
        `SELECT * FROM memory_proposals WHERE namespace=$1 AND owner_id=$2 AND ($3='all' OR status=$3) ORDER BY created_at DESC LIMIT 200`,
        owner,
        [status],
      )
    ).rows.map(proposal);
  }
  async getProposal(owner: string, id: string) {
    const row = (
      await this.query(
        `SELECT * FROM memory_proposals WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
        owner,
        [id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, '记忆候选不存在');
    return proposal(row);
  }
  async saveProposal(owner: string, value: Omit<MemoryProposal, 'id' | 'state' | 'createdAt'>) {
    const key = digest(
      `${value.scope}:${value.scopeId ?? ''}:${value.kind}:${contentKey(value.content)}:${value.sources
        .map((x) => x.hash)
        .sort()
        .join(',')}`,
    );
    const row = (
      await this.query(
        `INSERT INTO memory_proposals(namespace,owner_id,id,document,dedupe_key)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,owner_id,dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING *`,
        owner,
        [randomUUID(), JSON.stringify(value), key],
      )
    ).rows[0];
    return proposal(row);
  }
  async decision(owner: string, id: string, state: 'accepted' | 'rejected', memoryId?: string) {
    const result = await this.query(
      `UPDATE memory_proposals SET status=$4,memory_id=$5 WHERE namespace=$1 AND owner_id=$2 AND id=$3 AND status='pending' RETURNING id`,
      owner,
      [id, state, memoryId ?? null],
    );
    if (!result.rowCount) throw new HttpError(409, '该候选已处理或失效');
  }
  async decideProposal(owner: string, id: string, approve: boolean) {
    const memoryId = await this.db.transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT * FROM memory_proposals WHERE namespace=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`,
          [this.namespace, owner, id],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, '记忆候选不存在');
      if (row.status !== 'pending') throw new HttpError(409, '该候选已处理或失效');
      if (!approve) {
        await client.query(
          `UPDATE memory_proposals SET status='rejected' WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
          [this.namespace, owner, id],
        );
        return null;
      }
      const input = row.document as MemoryProposal;
      if (input.expiresAt && new Date(input.expiresAt).getTime() <= Date.now())
        throw new HttpError(409, '记忆候选已到期');
      const inserted = (
        await client.query(
          `INSERT INTO memory_items(namespace,owner_id,id,scope,scope_id,kind,content,tags,expires_at,dedupe_key,pinned,confirmed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) ON CONFLICT(namespace,owner_id,scope,scope_id,kind,dedupe_key) DO NOTHING RETURNING id`,
          [
            this.namespace,
            owner,
            randomUUID(),
            input.scope,
            input.scopeId ?? '',
            input.kind,
            input.content,
            JSON.stringify(row.document.tags ?? []),
            input.expiresAt,
            contentKey(input.content),
            row.document.pinned ?? false,
          ],
        )
      ).rows[0];
      const existing =
        inserted ??
        (
          await client.query(
            `SELECT id,status FROM memory_items WHERE namespace=$1 AND owner_id=$2 AND scope=$3 AND scope_id=$4 AND kind=$5 AND dedupe_key=$6`,
            [
              this.namespace,
              owner,
              input.scope,
              input.scopeId ?? '',
              input.kind,
              contentKey(input.content),
            ],
          )
        ).rows[0];
      if (existing.status === 'deleted') throw new HttpError(409, '该内容已删除，无法批准重复候选');
      await this.sources(client, owner, existing.id, input.sources);
      await client.query(
        `UPDATE memory_proposals SET status='accepted',memory_id=$4 WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
        [this.namespace, owner, id, existing.id],
      );
      return existing.id as string;
    });
    return memoryId ? this.get(owner, memoryId) : null;
  }
  async scopeState(owner: string, scope: 'group' | 'session', id: string) {
    const row = (
      await this.query(
        `SELECT * FROM memory_scope_state WHERE namespace=$1 AND owner_id=$2 AND scope=$3 AND scope_id=$4`,
        owner,
        [scope, id],
      )
    ).rows[0];
    const selections: Record<string, 'prefer' | 'exclude'> = {};
    if (scope === 'session')
      for (const s of (
        await this.query(
          `SELECT memory_id,mode FROM memory_selections WHERE namespace=$1 AND owner_id=$2 AND session_id=$3`,
          owner,
          [id],
        )
      ).rows)
        selections[s.memory_id] = s.mode === 'priority' ? 'prefer' : 'exclude';
    return {
      summary: row?.document.summary ?? '',
      revision: row?.version ?? 0,
      selections,
      updatedAt: row ? iso(row.updated_at) : new Date().toISOString(),
    };
  }
  async saveScopeState(
    owner: string,
    scope: 'group' | 'session',
    id: string,
    summary: string,
    selections: Record<string, 'prefer' | 'exclude'>,
    version: number,
  ) {
    await this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `${this.namespace}:${owner}:${scope}:${id}`,
      ]);
      const row = (
        await client.query(
          `SELECT version FROM memory_scope_state WHERE namespace=$1 AND owner_id=$2 AND scope=$3 AND scope_id=$4 FOR UPDATE`,
          [this.namespace, owner, scope, id],
        )
      ).rows[0];
      if ((row?.version ?? 0) !== version) throw new HttpError(409, '范围设置已改变，请刷新后重试');
      await client.query(
        `INSERT INTO memory_scope_state(namespace,owner_id,scope,scope_id,document) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(namespace,owner_id,scope,scope_id) DO UPDATE SET document=excluded.document,version=memory_scope_state.version+1,updated_at=now(),last_activity_at=now()`,
        [this.namespace, owner, scope, id, JSON.stringify({ summary })],
      );
      if (scope === 'session') {
        await client.query(
          `DELETE FROM memory_selections WHERE namespace=$1 AND owner_id=$2 AND session_id=$3`,
          [this.namespace, owner, id],
        );
        for (const [memoryId, mode] of Object.entries(selections))
          await client.query(
            `INSERT INTO memory_selections(namespace,owner_id,session_id,memory_id,mode) VALUES($1,$2,$3,$4,$5)`,
            [this.namespace, owner, id, memoryId, mode === 'prefer' ? 'priority' : 'exclude'],
          );
      }
    });
    return this.scopeState(owner, scope, id);
  }
  async touch(owner: string, sessionId: string, groupId: string | null) {
    for (const [scope, id] of [
      ['session', sessionId],
      ['group', groupId],
    ])
      if (id)
        await this.query(
          `INSERT INTO memory_scope_state(namespace,owner_id,scope,scope_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(namespace,owner_id,scope,scope_id) DO UPDATE SET last_activity_at=now()`,
          owner,
          [scope, id],
        );
  }
  async beginOperation(
    owner: string,
    kind: string,
    strategy: string,
    input: Record<string, unknown>,
    key?: string,
  ) {
    const id = randomUUID();
    const row = (
      await this.query(
        `INSERT INTO memory_operations(namespace,owner_id,id,kind,strategy_id,input,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(namespace,owner_id,kind,idempotency_key) DO NOTHING RETURNING *`,
        owner,
        [id, kind, strategy, JSON.stringify(input), key ?? null],
      )
    ).rows[0];
    if (row) return { operation: operation(row), created: true };
    const existing = (
      await this.query(
        `SELECT * FROM memory_operations WHERE namespace=$1 AND owner_id=$2 AND kind=$3 AND idempotency_key=$4`,
        owner,
        [kind, key],
      )
    ).rows[0];
    const equal = (
      await this.query(
        `SELECT input=$3::jsonb AS equal FROM memory_operations WHERE namespace=$1 AND owner_id=$2 AND id=$4`,
        owner,
        [JSON.stringify(input), existing.id],
      )
    ).rows[0]?.equal;
    if (!equal) throw new HttpError(409, '幂等键已用于不同请求');
    return { operation: operation(existing), created: false };
  }
  async finishOperation(
    owner: string,
    id: string,
    state: MemoryOperation['state'],
    result: Record<string, unknown> = {},
    error?: string,
  ) {
    await this.query(
      `UPDATE memory_operations SET status=$4,result=$5,error=$6,updated_at=now() WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
      owner,
      [id, state, JSON.stringify(result), error ?? null],
    );
  }
  async operations(owner: string, conversationId?: string, messageId?: string) {
    return (
      await this.query(
        `SELECT * FROM memory_operations WHERE namespace=$1 AND owner_id=$2
      AND ($3::text IS NULL OR input->>'conversationId'=$3) AND ($4::text IS NULL OR input->>'messageId'=$4 OR input->>'responseId'=$4)
      ORDER BY created_at DESC LIMIT 200`,
        owner,
        [conversationId ?? null, messageId ?? null],
      )
    ).rows.map(operation);
  }
  async getOperation(owner: string, id: string) {
    const row = (
      await this.query(
        `SELECT * FROM memory_operations WHERE namespace=$1 AND owner_id=$2 AND id=$3`,
        owner,
        [id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, '记忆操作不存在');
    return operation(row);
  }
  async interruptOperations() {
    await this.db.query(
      `UPDATE memory_operations SET status='error',error='服务重启中断，请手动重试',updated_at=now() WHERE namespace=$1 AND status IN ('running','prepared')`,
      [this.namespace],
    );
  }
  async invalidate(owner: string, conversationId: string, messageId: string) {
    await this.query(
      `UPDATE memory_proposals SET status='invalidated' WHERE namespace=$1 AND owner_id=$2 AND status='pending'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(document->'sources') s WHERE s->>'conversationId'=$3 AND s->>'messageId'=$4)`,
      owner,
      [conversationId, messageId],
    );
    const rows = await this.query(
      `UPDATE memory_items m SET status='review',index_status='pending'
      WHERE m.namespace=$1 AND m.owner_id=$2 AND m.status='active' AND EXISTS(SELECT 1 FROM memory_sources s WHERE s.namespace=m.namespace AND s.owner_id=m.owner_id AND s.memory_id=m.id AND s.conversation_id=$3 AND s.message_id=$4)
      RETURNING m.id`,
      owner,
      [conversationId, messageId],
    );
    return rows.rows.map((x) => x.id as string);
  }
  async detachConversation(owner: string, conversationId: string) {
    await this.query(
      `DELETE FROM memory_sources WHERE namespace=$1 AND owner_id=$2 AND conversation_id=$3`,
      owner,
      [conversationId],
    );
    await this.query(
      `DELETE FROM memory_proposals WHERE namespace=$1 AND owner_id=$2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(document->'sources') s WHERE s->>'conversationId'=$3)`,
      owner,
      [conversationId],
    );
  }
  async scopeRows(owner: string) {
    return (
      await this.query(
        `SELECT DISTINCT scope,scope_id AS id FROM memory_scope_state WHERE namespace=$1 AND owner_id=$2
      UNION SELECT DISTINCT scope,scope_id AS id FROM memory_items WHERE namespace=$1 AND owner_id=$2 AND scope<>'user' AND status<>'deleted'`,
        owner,
      )
    ).rows as { scope: 'group' | 'session'; id: string }[];
  }
  async removeScopeData(owner: string, scope: 'group' | 'session', id: string) {
    await this.query(
      `DELETE FROM memory_scope_state WHERE namespace=$1 AND owner_id=$2 AND scope=$3 AND scope_id=$4`,
      owner,
      [scope, id],
    );
    await this.query(
      `DELETE FROM memory_proposals WHERE namespace=$1 AND owner_id=$2 AND document->>'scope'=$3 AND document->>'scopeId'=$4`,
      owner,
      [scope, id],
    );
    if (scope === 'session')
      await this.query(
        `DELETE FROM memory_selections WHERE namespace=$1 AND owner_id=$2 AND session_id=$3`,
        owner,
        [id],
      );
  }
  async sourceRows(owner: string) {
    const rows = (
      await this.query(
        `SELECT DISTINCT conversation_id,message_id,source_hash FROM memory_sources WHERE namespace=$1 AND owner_id=$2
      UNION SELECT DISTINCT s->>'conversationId',s->>'messageId',s->>'hash' FROM memory_proposals p,jsonb_array_elements(p.document->'sources') s
      WHERE p.namespace=$1 AND p.owner_id=$2 AND p.status='pending'`,
        owner,
      )
    ).rows;
    return rows.map((x) => ({
      conversationId: x.conversation_id,
      messageId: x.message_id,
      hash: x.source_hash,
    }));
  }
  async expired(retentionDays: { group: number; session: number }, owner?: string) {
    const result = await this.db.query<Row>(
      `SELECT m.owner_id,m.id FROM memory_items m
      LEFT JOIN memory_scope_state s ON s.namespace=m.namespace AND s.owner_id=m.owner_id AND s.scope=m.scope AND s.scope_id=m.scope_id
      LEFT JOIN memory_preferences p ON p.namespace=m.namespace AND p.owner_id=m.owner_id
      WHERE m.namespace=$1 AND ($4::text IS NULL OR m.owner_id=$4) AND m.status<>'deleted' AND ((m.expires_at IS NOT NULL AND m.expires_at<=now())
        OR (m.scope IN ('group','session') AND COALESCE(s.last_activity_at,m.updated_at)<now()-
          make_interval(days=>COALESCE((p.document->'retentionDays'->>m.scope)::integer,CASE WHEN m.scope='group' THEN $2::integer ELSE $3::integer END)))) LIMIT 200`,
      [this.namespace, retentionDays.group, retentionDays.session, owner ?? null],
    );
    return result.rows.map((x) => ({ owner: x.owner_id as string, id: x.id as string }));
  }
  async expiredScopes(retentionDays: { group: number; session: number }, owner?: string) {
    const result = await this.db.query<Row>(
      `SELECT s.owner_id,s.scope,s.scope_id FROM memory_scope_state s
      LEFT JOIN memory_preferences p ON p.namespace=s.namespace AND p.owner_id=s.owner_id
      WHERE s.namespace=$1 AND ($4::text IS NULL OR s.owner_id=$4) AND s.last_activity_at<now()-
        make_interval(days=>COALESCE((p.document->'retentionDays'->>s.scope)::integer,CASE WHEN s.scope='group' THEN $2::integer ELSE $3::integer END)) LIMIT 200`,
      [this.namespace, retentionDays.group, retentionDays.session, owner ?? null],
    );
    return result.rows.map((x) => ({
      owner: x.owner_id as string,
      scope: x.scope as 'group' | 'session',
      id: x.scope_id as string,
    }));
  }
}
