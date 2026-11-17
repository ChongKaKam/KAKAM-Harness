import { randomUUID } from 'node:crypto';
import type { Database } from '../../kernel/database';
import { HttpError } from '../../kernel/http';
import { relayLifetimeMs, type RelayAttachment, type RelayCard } from './types';

type CardRow = Omit<RelayCard, 'attachments' | 'contentExpired'>;
type AttachmentInput = Pick<RelayAttachment, 'id' | 'filename' | 'sizeBytes'>;

const cardColumns = `id,title,content,color_slot AS colorSlot,created_at AS createdAt,
  updated_at AS updatedAt,expires_at AS expiresAt,persisted_at AS persistedAt`;
const attachmentColumns = `id,filename,size_bytes AS sizeBytes,created_at AS createdAt,
  expires_at AS expiresAt,persisted_at AS persistedAt`;
const alive = '(expires_at IS NULL OR expires_at>?)';
const cardVisible = `(${alive} OR EXISTS(
  SELECT 1 FROM relay_attachments WHERE card_id=relay_cards.id AND ${alive}
))`;
const ownedCard = '(SELECT id FROM relay_cards WHERE id=? AND user_id=?)';
const attachmentCardTitle = '附件卡片';

function toCard(row: CardRow, attachments: RelayAttachment[], now: string): RelayCard {
  const contentExpired = row.expiresAt !== null && row.expiresAt <= now;
  return {
    ...row,
    title: contentExpired ? attachmentCardTitle : row.title,
    content: contentExpired ? '' : row.content,
    contentExpired,
    attachments,
  };
}

export class RelayStore {
  constructor(private db: Database) {}

  prune(now = Date.now()): string[] {
    const cutoff = new Date(now).toISOString();
    return this.db.transaction(() => {
      const expired = this.db.all<{ id: string }>(
        'DELETE FROM relay_attachments WHERE expires_at<=? RETURNING id',
        cutoff,
      );
      this.db.run(
        `DELETE FROM relay_cards WHERE expires_at<=? AND NOT EXISTS(
          SELECT 1 FROM relay_attachments WHERE card_id=relay_cards.id
        )`,
        cutoff,
      );
      // Keep the parent ID for live attachments while removing the expired Markdown and title.
      this.db.run(
        "UPDATE relay_cards SET title=?,content='' WHERE expires_at<=? AND (title<>? OR content<>'')",
        attachmentCardTitle,
        cutoff,
        attachmentCardTitle,
      );
      return expired.map(({ id }) => id);
    });
  }

  list(userId: string): RelayCard[] {
    const now = new Date().toISOString();
    const attachments = this.db.all<RelayAttachment & { cardId: string }>(
      `SELECT ${attachmentColumns}, card_id AS cardId FROM relay_attachments
       WHERE card_id IN (SELECT id FROM relay_cards WHERE user_id=?) AND ${alive}
       ORDER BY created_at,id`,
      userId,
      now,
    );
    const byCard = new Map<string, RelayAttachment[]>();
    for (const { cardId, ...attachment } of attachments) {
      const cardAttachments = byCard.get(cardId);
      if (cardAttachments) cardAttachments.push(attachment);
      else byCard.set(cardId, [attachment]);
    }
    return this.db
      .all<CardRow>(
        `SELECT ${cardColumns} FROM relay_cards WHERE user_id=? AND ${cardVisible}
         ORDER BY created_at DESC,id`,
        userId,
        now,
        now,
      )
      .map((row) => toCard(row, byCard.get(row.id) ?? [], now));
  }

  get(userId: string, id: string): RelayCard {
    const now = new Date().toISOString();
    const card = this.db.get<CardRow>(
      `SELECT ${cardColumns} FROM relay_cards WHERE id=? AND user_id=? AND ${cardVisible}`,
      id,
      userId,
      now,
      now,
    );
    if (!card) throw new HttpError(404, '卡片不存在或已到期');
    const attachments = this.db.all<RelayAttachment>(
      `SELECT ${attachmentColumns} FROM relay_attachments
       WHERE card_id=${ownedCard} AND ${alive} ORDER BY created_at,id`,
      id,
      userId,
      now,
    );
    return toCard(card, attachments, now);
  }

  assertTextActive(userId: string, id: string): void {
    this.getActiveCard(userId, id, new Date().toISOString());
  }

  private getActiveCard(userId: string, id: string, now: string): CardRow {
    const card = this.db.get<CardRow>(
      `SELECT ${cardColumns} FROM relay_cards WHERE id=? AND user_id=? AND ${alive}`,
      id,
      userId,
      now,
    );
    if (!card) throw new HttpError(404, '卡片不存在或已到期');
    return card;
  }

  create(userId: string, input: { title: string; content: string }): RelayCard {
    const id = randomUUID();
    this.insertCard(userId, id, input, Date.now());
    return this.get(userId, id);
  }

  private insertCard(
    userId: string,
    id: string,
    input: { title: string; content: string },
    now: number,
  ): void {
    const createdAt = new Date(now).toISOString();
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
  }

  update(
    userId: string,
    id: string,
    input: Partial<Pick<RelayCard, 'title' | 'content' | 'colorSlot'>>,
  ): RelayCard {
    const now = new Date().toISOString();
    const previous = this.getActiveCard(userId, id, now);
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
    this.getActiveCard(userId, id, now);
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

  delete(userId: string, id: string): string[] {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const attachments = this.db.all<{ id: string }>(
        `SELECT id FROM relay_attachments WHERE card_id=${ownedCard}`,
        id,
        userId,
      );
      const result = this.db.run(
        `DELETE FROM relay_cards WHERE id=? AND user_id=? AND ${cardVisible}`,
        id,
        userId,
        now,
        now,
      );
      if (!result.changes) throw new HttpError(404, '卡片不存在或已到期');
      return attachments.map((attachment) => attachment.id);
    });
  }

  attachmentIds(): Set<string> {
    return new Set(
      this.db.all<{ id: string }>('SELECT id FROM relay_attachments').map(({ id }) => id),
    );
  }

  addAttachment(
    userId: string,
    cardId: string,
    input: AttachmentInput,
    newCardTitle?: string,
  ): RelayAttachment {
    const now = Date.now();
    const attachment: RelayAttachment = {
      id: input.id,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + relayLifetimeMs).toISOString(),
      persistedAt: null,
    };
    return this.db.transaction(() => {
      if (newCardTitle === undefined) this.getActiveCard(userId, cardId, attachment.createdAt);
      else this.insertCard(userId, cardId, { title: newCardTitle, content: '' }, now);
      this.db.run(
        `INSERT INTO relay_attachments(id,card_id,filename,size_bytes,created_at,expires_at)
         VALUES(?,?,?,?,?,?)`,
        attachment.id,
        cardId,
        attachment.filename,
        attachment.sizeBytes,
        attachment.createdAt,
        attachment.expiresAt,
      );
      return attachment;
    });
  }

  getAttachment(userId: string, cardId: string, id: string): RelayAttachment {
    const attachment = this.db.get<RelayAttachment>(
      `SELECT ${attachmentColumns} FROM relay_attachments
       WHERE id=? AND card_id=${ownedCard} AND ${alive}`,
      id,
      cardId,
      userId,
      new Date().toISOString(),
    );
    if (!attachment) throw new HttpError(404, '附件不存在或已到期');
    return attachment;
  }

  persistAttachment(userId: string, cardId: string, id: string): RelayAttachment {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE relay_attachments SET expires_at=NULL,persisted_at=?
       WHERE id=? AND card_id=${ownedCard} AND expires_at>?`,
      now,
      id,
      cardId,
      userId,
      now,
    );
    return this.getAttachment(userId, cardId, id);
  }

  deleteAttachment(userId: string, cardId: string, id: string): string {
    const result = this.db.run(
      `DELETE FROM relay_attachments WHERE id=? AND card_id=${ownedCard} AND ${alive}`,
      id,
      cardId,
      userId,
      new Date().toISOString(),
    );
    if (!result.changes) throw new HttpError(404, '附件不存在或已到期');
    return id;
  }
}
