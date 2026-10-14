import { randomUUID } from 'node:crypto';
import type { Database } from '../../kernel/database';
import { HttpError } from '../../kernel/http';
import { relayLifetimeMs, type RelayCard } from './types';

const columns = `id,title,content,color_slot AS colorSlot,created_at AS createdAt,
  updated_at AS updatedAt,expires_at AS expiresAt,persisted_at AS persistedAt`;
const alive = '(expires_at IS NULL OR expires_at>?)';

export class RelayStore {
  constructor(private db: Database) {}

  prune(now = Date.now()) {
    this.db.run('DELETE FROM relay_cards WHERE expires_at<=?', new Date(now).toISOString());
  }

  list(userId: string): RelayCard[] {
    this.prune();
    return this.db.all<RelayCard>(
      `SELECT ${columns} FROM relay_cards WHERE user_id=? AND ${alive} ORDER BY created_at DESC,id`,
      userId,
      new Date().toISOString(),
    );
  }

  get(userId: string, id: string): RelayCard {
    const card = this.db.get<RelayCard>(
      `SELECT ${columns} FROM relay_cards WHERE id=? AND user_id=? AND ${alive}`,
      id,
      userId,
      new Date().toISOString(),
    );
    if (!card) throw new HttpError(404, '卡片不存在或已到期');
    return card;
  }

  create(userId: string, input: { title: string; content: string }): RelayCard {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const id = randomUUID();
    this.db.run(
      `INSERT INTO relay_cards(id,user_id,title,content,created_at,updated_at,expires_at)
       VALUES(?,?,?,?,?,?,?)`,
      id,
      userId,
      input.title || '未命名卡片',
      input.content,
      createdAt,
      createdAt,
      new Date(now + relayLifetimeMs).toISOString(),
    );
    return this.get(userId, id);
  }

  update(
    userId: string,
    id: string,
    input: Partial<Pick<RelayCard, 'title' | 'content' | 'colorSlot'>>,
  ): RelayCard {
    const previous = this.get(userId, id);
    const now = new Date().toISOString();
    const result = this.db.run(
      `UPDATE relay_cards SET title=?,content=?,color_slot=?,updated_at=?
       WHERE id=? AND user_id=? AND ${alive}`,
      input.title === undefined ? previous.title : input.title || '未命名卡片',
      input.content ?? previous.content,
      input.colorSlot === undefined ? previous.colorSlot : input.colorSlot,
      now,
      id,
      userId,
      now,
    );
    if (!result.changes) throw new HttpError(404, '卡片不存在或已到期');
    return this.get(userId, id);
  }

  persist(userId: string, id: string): RelayCard {
    const now = new Date().toISOString();
    // Repeated confirmations preserve the first real confirmation time. Expired cards cannot revive.
    this.db.run(
      `UPDATE relay_cards SET expires_at=NULL,persisted_at=?,updated_at=?
       WHERE id=? AND user_id=? AND expires_at>? AND persisted_at IS NULL`,
      now,
      now,
      id,
      userId,
      now,
    );
    return this.get(userId, id);
  }

  delete(userId: string, id: string) {
    const result = this.db.run(
      `DELETE FROM relay_cards WHERE id=? AND user_id=? AND ${alive}`,
      id,
      userId,
      new Date().toISOString(),
    );
    if (!result.changes) throw new HttpError(404, '卡片不存在或已到期');
  }
}
