import { api } from '../../client/api';
import { relayLimits, type RelayCard, type RelayUpload, type RelayUploadProgress } from './types';

export function attachmentSize(sizeBytes: number) {
  const mib = 1024 * 1024;
  if (sizeBytes >= mib)
    return `${(sizeBytes / mib).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} MB`;
  if (sizeBytes >= 1024)
    return `${(sizeBytes / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB`;
  return `${sizeBytes} B`;
}

export async function uploadAttachment({
  cardId,
  title,
  file,
  signal,
  onProgress,
}: {
  cardId?: string;
  title: string;
  file: File;
  signal: AbortSignal;
  onProgress: (received: number) => void;
}) {
  const fileInfo = { filename: file.name, sizeBytes: file.size };
  const reservation = await api<RelayUpload>(
    cardId ? `/relay/${cardId}/attachments` : '/relay/attachments',
    {
      method: 'POST',
      body: JSON.stringify(cardId ? fileInfo : { ...fileInfo, title }),
      signal,
    },
  );
  const cardPath = `/relay/${reservation.cardId}`;
  const path = `${cardPath}/attachments/${reservation.id}/upload`;
  let sentFinalChunk = false;
  try {
    let offset = 0;
    do {
      const end = Math.min(offset + relayLimits.attachmentChunkBytes, file.size);
      sentFinalChunk = end === file.size;
      const chunk = {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.slice(offset, end),
        signal,
      };
      const chunkPath = `${path}?offset=${offset}`;
      const result = await api<RelayUploadProgress>(chunkPath, chunk).catch((error: unknown) => {
        if (!(error instanceof TypeError) || signal.aborted) throw error;
        return api<RelayUploadProgress>(chunkPath, chunk);
      });
      onProgress(result.received);
      if (result.attachment) return reservation.cardId;
      if (result.received !== end) throw new Error('上传进度异常，请重试');
      offset = result.received;
    } while (offset < file.size);
    throw new Error('附件保存失败，请重试');
  } catch (error) {
    try {
      await api(path, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    } catch {
      // A lost final response can leave an attachment that has already committed.
      if (sentFinalChunk) {
        const card = await api<RelayCard>(cardPath, { signal: AbortSignal.timeout(5000) }).catch(
          () => undefined,
        );
        if (card?.attachments.some(({ id }) => id === reservation.id)) return reservation.cardId;
      }
    }
    throw error;
  }
}
