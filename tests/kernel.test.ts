import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { KHKernel } from '../src/kernel';
import { createApp } from '../src/server/app';

test('feature transitions serialize and Cordis effects clean up exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-kernel-'));
  const kernel = new KHKernel(dir);
  let active = 0;
  let starts = 0;
  try {
    await kernel.register(
      { id: 'probe', name: 'Probe', kind: 'plugin', version: '1', description: 'Lifecycle probe' },
      {
        name: 'probe',
        inject: ['http'],
        apply(ctx) {
          ctx.effect(() => {
            starts++;
            active++;
            return () => {
              active--;
            };
          });
        },
      },
    );
    assert.equal(active, 1);
    await Promise.all([
      kernel.toggle('probe', false),
      kernel.toggle('probe', true),
      kernel.toggle('probe', true),
    ]);
    assert.equal(active, 1);
    assert.equal(starts, 2);
    await kernel.toggle('probe', false);
    assert.equal(active, 0);
    assert.equal(kernel.manifests(true)[0].enabled, false);
  } finally {
    await kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('first startup needs no file-based user credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-bootstrap-'));
  try {
    const { kernel } = await createApp({
      dataDir: dir,
      secret: 'test-secret-at-least-thirty-two-characters',
      port: 0,
      host: '127.0.0.1',
      secureCookies: false,
      trustProxy: 0,
    });
    assert.equal(
      kernel.ctx.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM users')?.count,
      0,
    );
    await kernel.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('v0.1 provider schema migrates in place without losing data or duplicating columns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-migration-'));
  const db = new DatabaseSync(join(dir, 'kakam.sqlite'));
  db.exec(
    "CREATE TABLE providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,base_url TEXT NOT NULL,encrypted_key TEXT NOT NULL); INSERT INTO providers VALUES('existing','Existing','http://localhost/v1','encrypted-placeholder')",
  );
  db.close();
  try {
    for (let restart = 0; restart < 2; restart++) {
      const kernel = new KHKernel(dir);
      const provider = kernel.ctx.db.get<{ api_mode: string; encrypted_key: string }>(
        'SELECT * FROM providers WHERE id=?',
        'existing',
      )!;
      assert.equal(provider.api_mode, 'chat-completions');
      assert.equal(provider.encrypted_key, 'encrypted-placeholder');
      await kernel.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('accent migration preserves existing theme and avatar across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-appearance-migration-'));
  let kernel = new KHKernel(dir);
  try {
    kernel.ctx.db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','placeholder','admin')",
    );
    kernel.ctx.db.connection.exec(`
      DROP TABLE ui_preferences;
      CREATE TABLE ui_preferences(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,theme TEXT NOT NULL DEFAULT 'system',assistant_icon TEXT);
      INSERT INTO ui_preferences VALUES('owner','dark','existing-avatar');
    `);
    await kernel.stop();
    for (let restart = 0; restart < 2; restart++) {
      kernel = new KHKernel(dir);
      const prefs = kernel.ctx.db.get<{
        theme: string;
        assistant_icon: string;
        accent_color: string;
      }>('SELECT * FROM ui_preferences WHERE user_id=?', 'owner')!;
      assert.equal(prefs.theme, 'dark');
      assert.equal(prefs.assistant_icon, 'existing-avatar');
      assert.equal(prefs.accent_color, 'sage');
      await kernel.stop();
    }
  } finally {
    await kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('email migration preserves legacy accounts and adds a case-insensitive unique index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-email-migration-'));
  const legacy = new DatabaseSync(join(dir, 'kakam.sqlite'));
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO users(id, username, display_name, password_hash, role) VALUES('original', 'old-admin', 'Original', 'existing-hash', 'admin');
  `);
  legacy.close();
  try {
    for (let restart = 0; restart < 2; restart++) {
      const kernel = new KHKernel(dir);
      try {
        const user = kernel.ctx.db.get<{
          email: string | null;
          username: string;
          password_hash: string;
          role: string;
        }>('SELECT * FROM users WHERE id=?', 'original')!;
        assert.equal(user.email, null);
        assert.equal(user.username, 'old-admin');
        assert.equal(user.password_hash, 'existing-hash');
        assert.equal(user.role, 'admin');
        if (restart === 0)
          kernel.ctx.db.run(
            "INSERT INTO users(id,username,email,display_name,password_hash,role) VALUES('new','new','new@example.test','New','hash','user')",
          );
        assert.throws(
          () =>
            kernel.ctx.db.run(
              'UPDATE users SET email=? WHERE id=?',
              'NEW@EXAMPLE.TEST',
              'original',
            ),
          /UNIQUE/,
        );
        assert.deepEqual(kernel.ctx.db.all('PRAGMA foreign_key_check'), []);
      } finally {
        await kernel.stop();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('message duration migration leaves legacy timings unknown and preserves recorded durations on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-duration-migration-'));
  let kernel = new KHKernel(dir);
  try {
    kernel.ctx.db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','hash','admin')",
    );
    kernel.ctx.db.run(
      "INSERT INTO conversations(id,user_id,title,updated_at) VALUES('conversation','owner','Old chat','2026-01-01')",
    );
    for (const id of ['old', 'timed'])
      kernel.ctx.db.run(
        "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,'conversation','assistant','Preserve me','2026-01-01')",
        id,
      );
    kernel.ctx.db.connection.exec('ALTER TABLE messages DROP COLUMN duration_ms');
    await kernel.stop();
    for (let restart = 0; restart < 2; restart++) {
      kernel = new KHKernel(dir);
      const rows = kernel.ctx.db.all<{ id: string; content: string; duration_ms: number | null }>(
        'SELECT id,content,duration_ms FROM messages ORDER BY id',
      );
      assert.deepEqual(
        rows.map((row) => row.content),
        ['Preserve me', 'Preserve me'],
      );
      assert.equal(rows[0].duration_ms, null);
      assert.equal(rows[1].duration_ms, restart === 0 ? null : 1234);
      assert.deepEqual(kernel.ctx.db.all('PRAGMA foreign_key_check'), []);
      if (restart === 0) kernel.ctx.db.run("UPDATE messages SET duration_ms=1234 WHERE id='timed'");
      await kernel.stop();
    }
  } finally {
    await kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('conversation groups migrate old chats, persist across restart and detach without deleting messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-group-migration-'));
  let kernel = new KHKernel(dir);
  try {
    kernel.ctx.db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','hash','admin')",
    );
    kernel.ctx.db.run(
      "INSERT INTO conversations(id,user_id,title,updated_at,color_slot) VALUES('chat','owner','Old chat','2026-01-01',6)",
    );
    kernel.ctx.db.run(
      "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('message','chat','user','Keep me','2026-01-01')",
    );
    kernel.ctx.db.connection.exec(
      'DROP INDEX idx_conversations_group; ALTER TABLE conversations DROP COLUMN group_id; DROP TABLE conversation_groups',
    );
    await kernel.stop();
    for (let restart = 0; restart < 2; restart++) {
      kernel = new KHKernel(dir);
      assert.deepEqual(
        kernel.ctx.db
          .all('SELECT title,color_slot,group_id FROM conversations')
          .map((r) => ({ ...(r as object) })),
        [{ title: 'Old chat', color_slot: 6, group_id: restart === 0 ? null : 'group' }],
      );
      if (restart === 0) {
        kernel.ctx.db.run(
          "INSERT INTO conversation_groups(id,user_id,name,icon,color_slot,created_at) VALUES('group','owner','Reading','📚',2,'2026-01-01')",
        );
        kernel.ctx.db.run("UPDATE conversations SET group_id='group' WHERE id='chat'");
      } else {
        assert.equal(
          kernel.ctx.db.get<{ icon: string }>('SELECT icon FROM conversation_groups')!.icon,
          '📚',
        );
        kernel.ctx.db.run("DELETE FROM conversation_groups WHERE id='group' AND user_id='owner'");
        assert.equal(
          kernel.ctx.db.get<{ group_id: null }>('SELECT group_id FROM conversations')!.group_id,
          null,
        );
        assert.equal(
          kernel.ctx.db.get<{ content: string }>('SELECT content FROM messages')!.content,
          'Keep me',
        );
      }
      assert.deepEqual(kernel.ctx.db.all('PRAGMA foreign_key_check'), []);
      await kernel.stop();
    }
  } finally {
    await kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('prompt metadata migrates without changing old content or colors and persists across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-prompt-migration-'));
  let kernel = new KHKernel(dir);
  try {
    kernel.ctx.db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('owner','owner','Owner','hash','admin')",
    );
    kernel.ctx.db.run(
      "INSERT INTO prompts(id,user_id,title,content,color_slot) VALUES('card','owner','Old card','Original content',6)",
    );
    kernel.ctx.db.run(
      "INSERT INTO providers(id,name,base_url,encrypted_key) VALUES('provider','Provider','https://example.test','unused')",
    );
    kernel.ctx.db.run(
      "INSERT INTO models(id,provider_id,name,label) VALUES('model','provider','small','Small')",
    );
    kernel.ctx.db.connection.exec(
      'ALTER TABLE prompts DROP COLUMN description; ALTER TABLE prompts DROP COLUMN tags; DROP TABLE prompt_preferences',
    );
    await kernel.stop();
    for (let restart = 0; restart < 2; restart++) {
      kernel = new KHKernel(dir);
      const card = kernel.ctx.db.get<{
        content: string;
        description: string;
        tags: string;
        color_slot: number;
      }>('SELECT * FROM prompts')!;
      assert.equal(card.content, 'Original content');
      assert.equal(card.color_slot, 6);
      assert.equal(card.description, restart === 0 ? '' : 'Saved introduction');
      assert.equal(card.tags, restart === 0 ? '[]' : '["写作"]');
      if (restart === 0) {
        kernel.ctx.db.run(
          "UPDATE prompts SET description='Saved introduction',tags='[\"写作\"]' WHERE id='card'",
        );
        kernel.ctx.db.run(
          "INSERT INTO prompt_preferences(user_id,summary_model_id) VALUES('owner','model')",
        );
      } else {
        assert.equal(
          kernel.ctx.db.get<{ summary_model_id: string }>('SELECT * FROM prompt_preferences')!
            .summary_model_id,
          'model',
        );
        kernel.ctx.db.run("DELETE FROM models WHERE id='model'");
        assert.equal(
          kernel.ctx.db.get<{ summary_model_id: null }>('SELECT * FROM prompt_preferences')!
            .summary_model_id,
          null,
        );
      }
      assert.deepEqual(kernel.ctx.db.all('PRAGMA foreign_key_check'), []);
      await kernel.stop();
    }
  } finally {
    await kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy prompts migrate once into versioned skills with ownership, color and disabled state intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kh-skill-migration-'));
  let kernel = new KHKernel(dir);
  try {
    kernel.ctx.db.run(
      "INSERT INTO users(id,username,display_name,password_hash,role) VALUES('skill-owner','skill-owner','Owner','hash','user')",
    );
    kernel.ctx.db.run(
      "INSERT INTO prompts(id,user_id,title,content,description,tags,color_slot) VALUES('legacy-skill','skill-owner','旧卡片','  保留原文空格  ','用途','[\"写作\"]',6)",
    );
    kernel.ctx.db.run("INSERT INTO settings VALUES('feature:prompts','false')");
    kernel.ctx.db.run("DELETE FROM settings WHERE key='migration:skills-v1'");
    await kernel.stop();
    kernel = new KHKernel(dir);
    const old = kernel.ctx.db.get<{ document: string }>(
      "SELECT document FROM skill_versions WHERE skill_id='legacy-skill' AND version=1",
    )!;
    assert.deepEqual(JSON.parse(old.document), {
      title: '旧卡片',
      content: '  保留原文空格  ',
      description: '用途',
      tags: ['写作'],
      files: [],
    });
    assert.deepEqual(
      {
        ...kernel.ctx.db.get<{ user_id: string; color_slot: number; current_version: number }>(
          "SELECT user_id,color_slot,current_version FROM skills WHERE id='legacy-skill'",
        ),
      },
      { user_id: 'skill-owner', color_slot: 6, current_version: 1 },
    );
    kernel.ctx.db.run("UPDATE skills SET deleted=1 WHERE id='legacy-skill'");
    await kernel.stop();
    kernel = new KHKernel(dir);
    assert.equal(
      kernel.ctx.db.get<{ deleted: number }>("SELECT deleted FROM skills WHERE id='legacy-skill'")!
        .deleted,
      1,
    );
    assert.equal(
      kernel.ctx.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM skill_versions')!.count,
      1,
    );
    assert.equal(
      kernel.ctx.db.get<{ value: string }>(
        "SELECT value FROM settings WHERE key='feature:prompts'",
      )!.value,
      'false',
    );
  } finally {
    await kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
