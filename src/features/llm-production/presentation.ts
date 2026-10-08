import type { ProductionArtifact } from './types';

export function productionBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

export function productionType(artifact: ProductionArtifact) {
  if (artifact.mimeType.startsWith('image/')) return '图片';
  const extension = artifact.name.split('.').at(-1);
  return extension && extension !== artifact.name ? extension.toUpperCase() : '文件';
}
