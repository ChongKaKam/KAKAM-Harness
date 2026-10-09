import type { ProductionArtifact } from './types';

export function productionBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

export function productionDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function productionExpiry(artifact: ProductionArtifact) {
  return artifact.expiresAt ? `${productionDate(artifact.expiresAt)} 到期` : '不过期';
}

export function productionDownload(artifact: ProductionArtifact) {
  return `/api/llm-production/artifacts/${encodeURIComponent(artifact.id)}/download`;
}

export function productionContent(artifact: ProductionArtifact) {
  return `/api/llm-production/artifacts/${encodeURIComponent(artifact.id)}/content`;
}

export function productionPreviewKind(artifact: ProductionArtifact) {
  const mime = artifact.mimeType.toLowerCase();
  if (['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return 'image';
  if (
    ['text/markdown', 'text/x-markdown'].includes(mime) ||
    (mime === 'text/plain' && /\.md(?:own)?$/i.test(artifact.name))
  )
    return 'markdown';
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml')
  )
    return 'text';
  return 'unsupported';
}

export function productionType(artifact: ProductionArtifact) {
  if (artifact.mimeType.startsWith('image/')) return '图片';
  const extension = artifact.name.split('.').at(-1);
  return extension && extension !== artifact.name ? extension.toUpperCase() : '文件';
}
