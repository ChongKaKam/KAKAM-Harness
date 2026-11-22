import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Service, type Context } from 'cordis';
import { accentColors } from '../shared/appearance';
export class Database extends Service {
  readonly connection: DatabaseSync;
  constructor(ctx: Context, dir: string) {
    super(ctx, 'db', true);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(join(dir, 'kakam.sqlite'));
    this.connection.exec(`
      PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, encrypted_key TEXT NOT NULL, api_mode TEXT NOT NULL DEFAULT 'responses');
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE, name TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, vision INTEGER NOT NULL DEFAULT 0, UNIQUE(provider_id, name));
      CREATE TABLE IF NOT EXISTS model_grants (model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(model_id,user_id));
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', model_name TEXT, status TEXT NOT NULL DEFAULT 'complete', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), model_name TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_date ON usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS ui_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, theme TEXT NOT NULL DEFAULT 'system', assistant_icon TEXT);
    `);
    // Providers created before protocol selection all used Chat Completions. Mark them
    // with their real protocol here so the LLM transition below also covers these databases.
    if (
      !this.all<{ name: string }>('PRAGMA table_info(providers)').some((c) => c.name === 'api_mode')
    ) {
      this.connection.exec(
        "ALTER TABLE providers ADD COLUMN api_mode TEXT NOT NULL DEFAULT 'chat-completions'",
      );
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(ui_preferences)').some(
        (c) => c.name === 'accent_color',
      )
    ) {
      this.connection.exec(
        "ALTER TABLE ui_preferences ADD COLUMN accent_color TEXT NOT NULL DEFAULT 'sage'",
      );
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(ui_preferences)').some(
        (c) => c.name === 'color_pattern',
      )
    ) {
      this.transaction(() => {
        this.connection.exec(
          "ALTER TABLE ui_preferences ADD COLUMN color_pattern TEXT NOT NULL DEFAULT 'natural'",
        );
        for (const color of accentColors)
          this.run(
            'UPDATE ui_preferences SET color_pattern=? WHERE accent_color=?',
            color.group,
            color.id,
          );
      });
    }
    for (const table of ['conversations', 'prompts']) {
      if (
        !this.all<{ name: string }>(`PRAGMA table_info(${table})`).some(
          (c) => c.name === 'color_slot',
        )
      )
        this.connection.exec(
          `ALTER TABLE ${table} ADD COLUMN color_slot INTEGER CHECK(color_slot IS NULL OR color_slot BETWEEN 0 AND 63)`,
        );
    }
    if (!this.all<{ name: string }>('PRAGMA table_info(users)').some((c) => c.name === 'email')) {
      this.connection.exec('ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE');
    }
    if (!this.all<{ name: string }>('PRAGMA table_info(users)').some((c) => c.name === 'avatar')) {
      this.connection.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
    }
    this.connection.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL',
    );
    if (
      !this.all<{ name: string }>('PRAGMA table_info(providers)').some(
        (c) => c.name === 'platform_url',
      )
    ) {
      this.connection.exec('ALTER TABLE providers ADD COLUMN platform_url TEXT');
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(models)').some((c) => c.name === 'sort_order')
    ) {
      this.transaction(() => {
        this.connection.exec('ALTER TABLE models ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
        // Preserve the pre-migration display order, then only change it on explicit reordering.
        this.all<{ id: string }>(
          'SELECT m.id FROM models m JOIN providers p ON p.id=m.provider_id ORDER BY p.name,m.label,m.id',
        ).forEach((model, index) =>
          this.run('UPDATE models SET sort_order=? WHERE id=?', index, model.id),
        );
      });
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(messages)').some(
        (c) => c.name === 'duration_ms',
      )
    ) {
      // Old messages have no reliable timing; do not infer it from timestamps or token counts.
      this.connection.exec(
        'ALTER TABLE messages ADD COLUMN duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0)',
      );
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(messages)').some((c) => c.name === 'error')
    ) {
      this.connection.exec('ALTER TABLE messages ADD COLUMN error TEXT');
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(messages)').some(
        (c) => c.name === 'extensions',
      )
    ) {
      this.connection.exec("ALTER TABLE messages ADD COLUMN extensions TEXT NOT NULL DEFAULT '[]'");
    }
    this.connection.exec(`CREATE TABLE IF NOT EXISTS extension_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      modes TEXT NOT NULL DEFAULT '{}'
    )`);
    this.connection.exec(`CREATE TABLE IF NOT EXISTS conversation_groups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'folder',
      color_slot INTEGER CHECK(color_slot IS NULL OR color_slot BETWEEN 0 AND 63),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_groups_user ON conversation_groups(user_id)`);
    if (
      !this.all<{ name: string }>('PRAGMA table_info(conversations)').some(
        (c) => c.name === 'group_id',
      )
    ) {
      this.connection.exec(
        'ALTER TABLE conversations ADD COLUMN group_id TEXT REFERENCES conversation_groups(id) ON DELETE SET NULL',
      );
    }
    this.connection.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_group ON conversations(group_id)',
    );
    for (const [name, definition] of [
      ['description', "TEXT NOT NULL DEFAULT ''"],
      ['tags', "TEXT NOT NULL DEFAULT '[]'"],
    ]) {
      if (!this.all<{ name: string }>('PRAGMA table_info(prompts)').some((c) => c.name === name))
        this.connection.exec(`ALTER TABLE prompts ADD COLUMN ${name} ${definition}`);
    }
    this.connection.exec(`CREATE TABLE IF NOT EXISTS prompt_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      summary_model_id TEXT REFERENCES models(id) ON DELETE SET NULL
    )`);
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL, current_version INTEGER NOT NULL, color_slot INTEGER,
        deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,name)
      );
      CREATE TABLE IF NOT EXISTS skill_versions (
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY(skill_id,version)
      );
      CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);
    `);
    if (!this.get("SELECT key FROM settings WHERE key='migration:skills-v1'")) {
      this.transaction(() => {
        for (const row of this.all<{
          id: string;
          user_id: string;
          title: string;
          content: string;
          description: string;
          tags: string;
          color_slot: number | null;
        }>('SELECT * FROM prompts')) {
          this.run(
            'INSERT INTO skills(id,user_id,name,current_version,color_slot) VALUES(?,?,?,1,?)',
            row.id,
            row.user_id,
            `skill-${row.id}`,
            row.color_slot,
          );
          this.run(
            'INSERT INTO skill_versions(skill_id,version,document) VALUES(?,1,?)',
            row.id,
            JSON.stringify({
              title: row.title,
              content: row.content,
              description: row.description,
              tags: JSON.parse(row.tags),
              files: [],
            }),
          );
        }
        this.run("INSERT INTO settings(key,value) VALUES('migration:skills-v1','true')");
      });
    }
    for (const [table, column] of [
      ['conversations', 'skills'],
      ['messages', 'skills'],
      ['messages', 'skill_reads'],
      ['messages', 'calls'],
    ] as const) {
      if (!this.all<{ name: string }>(`PRAGMA table_info(${table})`).some((c) => c.name === column))
        this.connection.exec(
          `ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '[]'`,
        );
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(models)').some(
        (c) => c.name === 'tool_calling',
      )
    )
      this.connection.exec('ALTER TABLE models ADD COLUMN tool_calling INTEGER NOT NULL DEFAULT 0');
    if (!this.all<{ name: string }>('PRAGMA table_info(models)').some((c) => c.name === 'kind')) {
      this.transaction(() => {
        this.connection.exec(
          "ALTER TABLE models ADD COLUMN kind TEXT NOT NULL DEFAULT 'llm' CHECK(kind IN ('llm','jev','embedding','image'))",
        );
        this.run(
          "UPDATE models SET kind='jev' WHERE provider_id IN (SELECT id FROM providers WHERE api_mode='jev')",
        );
      });
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(models)').some(
        (c) => c.name === 'needs_protocol_review',
      )
    ) {
      this.transaction(() => {
        this.connection.exec(`
          ALTER TABLE models ADD COLUMN needs_protocol_review INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE models ADD COLUMN legacy_embedding_fingerprint INTEGER NOT NULL DEFAULT 0;
          UPDATE models SET legacy_embedding_fingerprint=1
            WHERE kind='embedding' AND provider_id IN
              (SELECT id FROM providers WHERE api_mode='chat-completions');
          UPDATE models SET enabled=0, needs_protocol_review=1
            WHERE enabled=1 AND kind='llm' AND provider_id IN
              (SELECT id FROM providers WHERE api_mode='chat-completions');
          UPDATE providers SET api_mode='responses' WHERE api_mode='chat-completions';
        `);
        const mode = this.all<{ name: string; dflt_value: string | null }>(
          'PRAGMA table_info(providers)',
        ).find((c) => c.name === 'api_mode')!;
        if (mode.dflt_value !== "'responses'") {
          // SQLite does not change a column default in place. Preserve the provider rows
          // and their foreign keys, replacing only the protocol column.
          this.connection.exec(`
            ALTER TABLE providers ADD COLUMN new_api_mode TEXT NOT NULL DEFAULT 'responses';
            UPDATE providers SET new_api_mode=api_mode;
            ALTER TABLE providers DROP COLUMN api_mode;
            ALTER TABLE providers RENAME COLUMN new_api_mode TO api_mode;
          `);
        }
      });
    }
    for (const column of ['embedding_dimensions', 'validated_dimensions']) {
      if (!this.all<{ name: string }>('PRAGMA table_info(models)').some((c) => c.name === column))
        this.connection.exec(
          `ALTER TABLE models ADD COLUMN ${column} INTEGER CHECK(${column} IS NULL OR ${column} BETWEEN 1 AND 16000)`,
        );
    }
    // SQLite cannot widen a column CHECK in place. Copy the existing schema and rows,
    // keeping IDs, grants, preferences, provider references and any model indexes.
    const modelSchema = this.get<{ sql: string }>(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='models'",
    )!.sql;
    const oldKindCheck =
      /CHECK\s*\(\s*kind\s+IN\s*\(\s*'llm'\s*,\s*'jev'\s*,\s*'embedding'\s*\)\s*\)/i;
    if (oldKindCheck.test(modelSchema)) {
      const indexes = this.all<{ sql: string }>(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='models' AND sql IS NOT NULL",
      );
      const names = this.all<{ name: string }>('PRAGMA table_info(models)')
        .map(({ name }) => `"${name.replaceAll('"', '""')}"`)
        .join(',');
      this.connection.exec('PRAGMA foreign_keys=OFF');
      try {
        this.transaction(() => {
          this.connection.exec(
            modelSchema
              .replace(/^CREATE TABLE\s+models\b/i, 'CREATE TABLE models_image_migration')
              .replace(oldKindCheck, "CHECK(kind IN ('llm','jev','embedding','image'))"),
          );
          this.connection.exec(
            `INSERT INTO models_image_migration(${names}) SELECT ${names} FROM models`,
          );
          this.connection.exec('DROP TABLE models');
          this.connection.exec('ALTER TABLE models_image_migration RENAME TO models');
          for (const index of indexes) this.connection.exec(index.sql);
          if (this.all('PRAGMA foreign_key_check').length)
            throw new Error('Model migration would invalidate database references');
        });
      } finally {
        this.connection.exec('PRAGMA foreign_keys=ON');
      }
    }
    const modelColumns = this.all<{ name: string }>('PRAGMA table_info(models)').map((c) => c.name);
    if (!modelColumns.includes('context_window_tokens'))
      this.connection.exec(
        'ALTER TABLE models ADD COLUMN context_window_tokens INTEGER CHECK(context_window_tokens >= 2)',
      );
    if (!modelColumns.includes('max_output_tokens'))
      this.connection.exec(
        'ALTER TABLE models ADD COLUMN max_output_tokens INTEGER CHECK(max_output_tokens > 0 AND max_output_tokens < context_window_tokens)',
      );
    // Snapshots belong to the conversation, not the replaceable assistant message.
    // Keep edited/retried attempts until their owner deletes the conversation.
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS context_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        handoff_model_id TEXT
      );
      CREATE TABLE IF NOT EXISTS context_snapshots (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_owner
        ON context_snapshots(user_id, conversation_id);
      CREATE TABLE IF NOT EXISTS context_compressions (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        settings_hash TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_count INTEGER NOT NULL CHECK(source_count > 0),
        summary TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    if (
      !this.all<{ name: string }>('PRAGMA table_info(context_preferences)').some(
        (c) => c.name === 'config',
      )
    )
      this.connection.exec(
        "ALTER TABLE context_preferences ADD COLUMN config TEXT NOT NULL DEFAULT '{}'",
      );
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS production_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        temporary_retention_days INTEGER NOT NULL DEFAULT 7 CHECK(temporary_retention_days BETWEEN 3 AND 7),
        image_model_id TEXT REFERENCES models(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS production_artifacts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        message_id TEXT,
        group_id TEXT REFERENCES conversation_groups(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size >= 0 AND size <= 20971520),
        data BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        temporary_started_at TEXT,
        expires_at TEXT,
        idempotency_key TEXT,
        UNIQUE(user_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_production_artifacts_owner ON production_artifacts(user_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_production_artifacts_conversation ON production_artifacts(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_production_artifacts_group ON production_artifacts(group_id);
      CREATE INDEX IF NOT EXISTS idx_production_artifacts_expiry ON production_artifacts(expires_at) WHERE expires_at IS NOT NULL;
    `);
    for (const [column, declaration] of [
      [
        'production_mode',
        "TEXT NOT NULL DEFAULT 'auto' CHECK(production_mode IN ('auto','required'))",
      ],
      ['production_plan', 'TEXT'],
      ['production_image_failure', 'TEXT'],
    ]) {
      if (!this.all<{ name: string }>('PRAGMA table_info(messages)').some((c) => c.name === column))
        this.connection.exec(`ALTER TABLE messages ADD COLUMN ${column} ${declaration}`);
    }
    if (
      !this.all<{ name: string }>('PRAGMA table_info(production_artifacts)').some(
        (c) => c.name === 'delivery_item_id',
      )
    )
      this.connection.exec('ALTER TABLE production_artifacts ADD COLUMN delivery_item_id TEXT');
    this.connection.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_production_artifacts_delivery_item
      ON production_artifacts(user_id,message_id,delivery_item_id) WHERE delivery_item_id IS NOT NULL;
    `);
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS relay_cards (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        color_slot INTEGER CHECK(color_slot BETWEEN 0 AND 63),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        persisted_at TEXT,
        CHECK((persisted_at IS NULL AND expires_at IS NOT NULL) OR
              (persisted_at IS NOT NULL AND expires_at IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_relay_cards_owner ON relay_cards(user_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_relay_cards_expiry ON relay_cards(expires_at)
        WHERE expires_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS relay_attachments (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES relay_cards(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 0 AND 314572800),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        persisted_at TEXT,
        CHECK((persisted_at IS NULL AND expires_at IS NOT NULL) OR
              (persisted_at IS NOT NULL AND expires_at IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_relay_attachments_card ON relay_attachments(card_id,created_at);
      CREATE INDEX IF NOT EXISTS idx_relay_attachments_expiry ON relay_attachments(expires_at)
        WHERE expires_at IS NOT NULL;
    `);
    if (
      !this.all<{ name: string }>('PRAGMA table_info(messages)').some(
        (c) => c.name === 'harness_run',
      )
    )
      this.connection.exec('ALTER TABLE messages ADD COLUMN harness_run TEXT');
    // Only explicit new-chat initialization creates a workspace. Legacy rows stay outside this namespace.
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS harness_workspaces (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS harness_submissions (
        request_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES harness_workspaces(conversation_id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_harness_submissions_chat ON harness_submissions(conversation_id);
      CREATE TABLE IF NOT EXISTS harness_documents (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES harness_workspaces(conversation_id) ON DELETE CASCADE,
        group_id TEXT REFERENCES conversation_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL, version INTEGER NOT NULL,
        CHECK((conversation_id IS NULL) <> (group_id IS NULL)),
        UNIQUE(conversation_id,name), UNIQUE(group_id,name)
      );
      CREATE TABLE IF NOT EXISTS harness_revisions (
        document_id TEXT NOT NULL REFERENCES harness_documents(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, content TEXT NOT NULL, size_bytes INTEGER AS (length(CAST(content AS BLOB)) + 256) STORED, PRIMARY KEY(document_id,version)
      );
      CREATE TABLE IF NOT EXISTS harness_publications (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES conversation_groups(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
        source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        content TEXT NOT NULL, size_bytes INTEGER AS (length(CAST(content AS BLOB)) + 256) STORED, PRIMARY KEY(group_id,document_id,version)
      );
      CREATE TABLE IF NOT EXISTS harness_direct_shares (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES conversation_groups(id) ON DELETE CASCADE,
        target_conversation_id TEXT NOT NULL REFERENCES harness_workspaces(conversation_id) ON DELETE CASCADE,
        document_id TEXT NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY(user_id,target_conversation_id,group_id,document_id,version),
        FOREIGN KEY(document_id,version) REFERENCES harness_revisions(document_id,version) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS harness_access (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES conversation_groups(id) ON DELETE CASCADE,
        source_conversation_id TEXT NOT NULL REFERENCES harness_workspaces(conversation_id) ON DELETE CASCADE,
        target_conversation_id TEXT NOT NULL REFERENCES harness_workspaces(conversation_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, purpose TEXT NOT NULL,
        document_id TEXT REFERENCES harness_documents(id) ON DELETE CASCADE, version INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending','preauthorized','approved','rejected')),
        created_at TEXT NOT NULL, expires_at TEXT, request_key TEXT, grant_key TEXT,
        UNIQUE(user_id,request_key), UNIQUE(user_id,grant_key),
        CHECK((version IS NULL) = (document_id IS NULL))
      );
      CREATE INDEX IF NOT EXISTS idx_harness_access_target ON harness_access(user_id,target_conversation_id,status);
      CREATE TABLE IF NOT EXISTS harness_preferences (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL, version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','active','withdrawn')), admitted_at TEXT,
        size_bytes INTEGER AS (length(CAST(content AS BLOB)) + 256) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_harness_preferences_user ON harness_preferences(user_id,status);
    `);
    // A published version can outlive its source conversation. Its bytes remain in the
    // owner-counted artifact store; deleting the bytes invalidates all views of that version.
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS harness_artifact_revisions (
        document_id TEXT NOT NULL, version INTEGER NOT NULL,
        artifact_id TEXT NOT NULL UNIQUE REFERENCES production_artifacts(id) ON DELETE CASCADE,
        PRIMARY KEY(document_id,version)
      );
      CREATE TRIGGER IF NOT EXISTS harness_artifact_revision_removed AFTER DELETE ON harness_artifact_revisions BEGIN
        DELETE FROM harness_publications WHERE document_id=OLD.document_id AND version=OLD.version;
        DELETE FROM harness_access WHERE document_id=OLD.document_id AND version=OLD.version;
        DELETE FROM harness_revisions WHERE document_id=OLD.document_id AND version=OLD.version;
        DELETE FROM harness_documents WHERE id=OLD.document_id AND kind='artifact'
          AND NOT EXISTS(SELECT 1 FROM harness_revisions WHERE document_id=OLD.document_id);
      END;
      CREATE TRIGGER IF NOT EXISTS harness_artifact_published AFTER INSERT ON harness_publications WHEN NEW.kind='artifact' BEGIN
        UPDATE production_artifacts SET expires_at=NULL,temporary_started_at=NULL WHERE user_id=NEW.user_id
          AND id=(SELECT artifact_id FROM harness_artifact_revisions WHERE document_id=NEW.document_id AND version=NEW.version);
      END;
      CREATE TRIGGER IF NOT EXISTS harness_artifact_unpublished AFTER DELETE ON harness_publications WHEN OLD.kind='artifact' BEGIN
        UPDATE production_artifacts SET temporary_started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+' || COALESCE(
            (SELECT temporary_retention_days FROM production_preferences WHERE user_id=OLD.user_id),7) || ' days')
          WHERE user_id=OLD.user_id AND group_id IS NULL
            AND id=(SELECT artifact_id FROM harness_artifact_revisions WHERE document_id=OLD.document_id AND version=OLD.version)
            AND NOT EXISTS(SELECT 1 FROM harness_publications WHERE document_id=OLD.document_id AND version=OLD.version);
      END;
    `);
    this.transaction(() => {
      const legacy = this.all<{ name: string }>('PRAGMA table_info(openai_gateway_keys)').some(
        (column) => column.name === 'provider_id',
      );
      if (legacy)
        this.connection.exec(
          'ALTER TABLE openai_gateway_keys RENAME TO openai_gateway_legacy_keys',
        );
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS openai_gateway_config (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          encrypted_key TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS openai_gateway_keys (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          prefix TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          legacy_encrypted_key TEXT
        );
      `);
      if (legacy) {
        // Snapshot only the official OpenAI source each device was actually bound to.
        // Several devices may have used different upstream projects under one admin.
        this.connection.exec(`
          INSERT INTO openai_gateway_keys(id,user_id,name,prefix,key_hash,created_at,legacy_encrypted_key)
          SELECT k.id,k.user_id,k.name,k.prefix,k.key_hash,k.created_at,p.encrypted_key
          FROM openai_gateway_legacy_keys k LEFT JOIN providers p ON p.id=k.provider_id
            AND rtrim(p.base_url,'/')='https://api.openai.com/v1'
            AND p.api_mode IN ('responses','chat-completions');
          INSERT INTO openai_gateway_config(user_id,encrypted_key)
          SELECT k.user_id, MIN(k.legacy_encrypted_key)
          FROM openai_gateway_keys k JOIN openai_gateway_legacy_keys old ON old.id=k.id
          GROUP BY k.user_id
          HAVING COUNT(DISTINCT old.provider_id)=1 AND MIN(k.legacy_encrypted_key) IS NOT NULL;
          DROP TABLE openai_gateway_legacy_keys;
        `);
      }
      this.connection.exec(
        'CREATE INDEX IF NOT EXISTS idx_openai_gateway_keys_user ON openai_gateway_keys(user_id, created_at)',
      );
    });
    this.transaction(() => {
      if (
        this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='openai_gateway_metrics'")
      )
        return;
      // The original gateway recorded its source only in model_name. Identify old calls
      // at upgrade time and leave their unmeasured cache counts and latency unknown.
      this.connection.exec(`CREATE TABLE openai_gateway_metrics (
        usage_id TEXT PRIMARY KEY REFERENCES usage(id) ON DELETE CASCADE,
        cached_input_tokens INTEGER CHECK(cached_input_tokens >= 0),
        duration_ms INTEGER CHECK(duration_ms >= 0)
      );
      INSERT INTO openai_gateway_metrics(usage_id)
        SELECT id FROM usage WHERE instr(model_name, '[OpenAI Gateway] ')=1`);
    });
    ctx.on('dispose', () => this.connection.close());
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.connection.prepare(sql).all(...params) as T[];
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.connection.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.connection.prepare(sql).run(...params);
  }
  transaction<T>(fn: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.connection.exec('COMMIT');
      return value;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }
}
