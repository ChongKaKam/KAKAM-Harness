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
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, encrypted_key TEXT NOT NULL);
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
    // Additive migration: keep the existing DB filename/volume and existing provider settings.
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
