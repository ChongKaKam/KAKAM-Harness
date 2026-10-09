import { Code2, File, FileText, Files, Image, Presentation, Sheet } from 'lucide-react';
import type { ProductionArtifact } from './types';

export type ProductionCategory = 'image' | 'document' | 'web';

export function productionCategory(artifact: ProductionArtifact): ProductionCategory {
  if (/\.(html?|svg)$/i.test(artifact.name) || artifact.mimeType === 'text/html') return 'web';
  return artifact.mimeType.startsWith('image/') ? 'image' : 'document';
}

function artifactIcon(artifact: ProductionArtifact) {
  if (productionCategory(artifact) === 'web') return Code2;
  if (productionCategory(artifact) === 'image') return Image;
  if (/\.(xlsx?|csv)$/i.test(artifact.name)) return Sheet;
  if (/\.(pptx?|odp)$/i.test(artifact.name)) return Presentation;
  if (/\.(json|[cm]?[jt]sx?|py|css|xml|sh)$/i.test(artifact.name)) return Code2;
  return FileText;
}

export function ProductionFileIcon({
  artifacts,
  size = 48,
}: {
  artifacts: ProductionArtifact[];
  size?: number;
}) {
  const icons = new Set(artifacts.map(artifactIcon));
  const Icon = icons.size > 1 ? Files : artifacts[0] ? artifactIcon(artifacts[0]) : File;
  return <Icon size={size} strokeWidth={1.5} aria-hidden="true" />;
}
