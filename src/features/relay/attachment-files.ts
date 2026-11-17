import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { appendFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HttpError } from '../../kernel/http';
import type { RelayStore } from './store';
import { relayLimits, type RelayUpload, type RelayUploadProgress } from './types';

interface PendingUpload extends RelayUpload {
  userId: string;
  filename: string;
  sizeBytes: number;
  newCardTitle?: string;
  received: number;
  lastOffset: number | null;
  lastActivity: number;
  busy: boolean;
}

const uploadIdleMs = 60 * 60 * 1000;
const storedFilename = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\.part)?$/;

export class RelayAttachmentFiles {
  private directory: string;
  private pending = new Map<string, PendingUpload>();

  constructor(
    dataDir: string,
    private store: RelayStore,
  ) {
    this.directory = resolve(dataDir, 'relay-attachments');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  path(id: string) {
    return resolve(this.directory, id);
  }

  start(
    userId: string,
    cardId: string,
    input: { filename: string; sizeBytes: number },
    newCardTitle?: string,
  ): RelayUpload {
    if (newCardTitle === undefined) this.store.assertTextActive(userId, cardId);
    const id = randomUUID();
    this.pending.set(id, {
      id,
      cardId,
      userId,
      ...input,
      newCardTitle,
      received: 0,
      lastOffset: null,
      lastActivity: Date.now(),
      busy: false,
    });
    return { id, cardId };
  }

  async writeChunk(
    userId: string,
    cardId: string,
    id: string,
    offset: number,
    readChunk: () => Promise<Buffer>,
  ): Promise<RelayUploadProgress> {
    const upload = this.find(userId, cardId, id);
    if (!upload) {
      const attachment = this.store.getAttachment(userId, cardId, id);
      return { received: attachment.sizeBytes, attachment };
    }
    if (upload.busy) throw new HttpError(409, '正在写入上传分段');
    if (offset === upload.lastOffset) return { received: upload.received };
    if (offset !== upload.received) throw new HttpError(409, '上传分段位置不匹配');
    upload.busy = true;
    const temporary = `${id}.part`;
    try {
      const chunk = await readChunk();
      this.assertPending(upload);
      const received = offset + chunk.length;
      if (chunk.length > relayLimits.attachmentChunkBytes || received > upload.sizeBytes)
        throw new HttpError(413, '上传数据超出声明的附件大小或分段上限');
      if (chunk.length === 0 && received < upload.sizeBytes)
        throw new HttpError(400, '上传分段不能为空');

      try {
        if (upload.newCardTitle === undefined) this.store.assertTextActive(userId, cardId);
        await appendFile(this.path(temporary), chunk, { mode: 0o600 });
        this.assertPending(upload);
        if (received === upload.sizeBytes) {
          await rename(this.path(temporary), this.path(id));
          this.assertPending(upload);
          const attachment = this.store.addAttachment(userId, cardId, upload, upload.newCardTitle);
          this.pending.delete(id);
          return { received, attachment };
        }
        upload.received = received;
        upload.lastOffset = offset;
        upload.lastActivity = Date.now();
        return { received };
      } catch (error) {
        this.pending.delete(id);
        this.remove([temporary, id]);
        throw error;
      }
    } finally {
      upload.busy = false;
      if (!this.pending.has(id)) this.remove([temporary]);
    }
  }

  cancel(userId: string, cardId: string, id: string) {
    const upload = this.find(userId, cardId, id);
    if (!upload) throw new HttpError(404, '上传已结束或不存在');
    this.discard(upload);
  }

  reconcile() {
    const now = Date.now();
    for (const upload of this.pending.values()) {
      if (!upload.busy && now - upload.lastActivity >= uploadIdleMs) this.discard(upload);
    }
    const storedIds = this.store.attachmentIds();
    const orphans = readdirSync(this.directory).filter((name) => {
      if (!storedFilename.test(name)) return false;
      const id = name.replace(/\.part$/, '');
      return !this.pending.has(id) && (name.endsWith('.part') || !storedIds.has(id));
    });
    this.remove(orphans);
  }

  remove(names: string[]) {
    for (const name of names) {
      try {
        rmSync(this.path(name), { force: true });
      } catch {
        console.warn('Relay attachment cleanup failed');
      }
    }
  }

  dispose() {
    for (const upload of this.pending.values()) this.discard(upload);
  }

  private find(userId: string, cardId: string, id: string) {
    const upload = this.pending.get(id);
    if (upload?.userId !== userId || upload.cardId !== cardId) return undefined;
    if (!upload.busy && Date.now() - upload.lastActivity >= uploadIdleMs) {
      this.discard(upload);
      return undefined;
    }
    return upload;
  }

  private assertPending(upload: PendingUpload) {
    if (!this.pending.has(upload.id)) throw new HttpError(404, '上传已结束或不存在');
  }

  private discard(upload: PendingUpload) {
    this.pending.delete(upload.id);
    if (!upload.busy) this.remove([`${upload.id}.part`]);
  }
}
