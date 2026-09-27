import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server/app';
import { imageData } from './mock-provider';

test('v0.5 color preferences migrate once without losing content or later selections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drift-colors-'));
  const legacy = new DatabaseSync(join(dir, 'kakam.sqlite'));
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), email TEXT);
    INSERT INTO users(id,username,display_name,password_hash,role,email) VALUES('owner','owner','Owner','unused','admin','owner@example.test');
    CREATE TABLE ui_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id), theme TEXT NOT NULL, assistant_icon TEXT, accent_color TEXT NOT NULL);
    INSERT INTO ui_preferences VALUES('owner','dark',NULL,'soft-sage');
    CREATE TABLE conversations (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO conversations VALUES('chat','owner','Keep my title','2026-09-27');
    CREATE TABLE prompts (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,content TEXT NOT NULL);
    INSERT INTO prompts VALUES('prompt','owner','Keep my card','Keep my content');
  `);
  legacy.close();
  const config = {
    dataDir: dir,
    secret: 'color-migration-fixture-secret-32-characters',
    port: 0,
    host: '127.0.0.1',
    secureCookies: false,
    trustProxy: 0,
  };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(config);
    const db = app.kernel.ctx.db;
    assert.equal(db.get<{ avatar: string | null }>('SELECT avatar FROM users')!.avatar, null);
    db.run('UPDATE users SET avatar=?', imageData);
    assert.deepEqual(
      {
        ...db.get<Record<string, unknown>>(
          'SELECT theme,accent_color,color_pattern FROM ui_preferences',
        ),
      },
      {
        theme: 'dark',
        accent_color: 'soft-sage',
        color_pattern: 'classic',
      },
    );
    assert.deepEqual(
      { ...db.get<Record<string, unknown>>('SELECT title,color_slot FROM conversations') },
      {
        title: 'Keep my title',
        color_slot: null,
      },
    );
    assert.deepEqual(
      { ...db.get<Record<string, unknown>>('SELECT content,color_slot FROM prompts') },
      {
        content: 'Keep my content',
        color_slot: null,
      },
    );
    db.run("UPDATE ui_preferences SET color_pattern='natural'");
    db.run('UPDATE conversations SET color_slot=6');
    db.run('UPDATE prompts SET color_slot=8');
    await app.kernel.stop();
    app = await createApp(config);
    assert.equal(
      app.kernel.ctx.db.get<{ avatar: string }>('SELECT avatar FROM users')!.avatar,
      imageData,
    );
    assert.equal(
      app.kernel.ctx.db.get<{ color_pattern: string }>('SELECT color_pattern FROM ui_preferences')!
        .color_pattern,
      'natural',
    );
    assert.equal(
      app.kernel.ctx.db.get<{ color_slot: number }>('SELECT color_slot FROM conversations')!
        .color_slot,
      6,
    );
    assert.equal(
      app.kernel.ctx.db.get<{ color_slot: number }>('SELECT color_slot FROM prompts')!.color_slot,
      8,
    );
    assert.equal(app.kernel.ctx.db.all('PRAGMA foreign_key_check').length, 0);
  } finally {
    await app?.kernel.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
