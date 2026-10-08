import { Download, File, Image } from 'lucide-react';
import type { ProductionArtifact } from './types';
import { productionBytes, productionDownload, productionExpiry } from './presentation';
import './production.css';

export function MessageArtifacts({ artifacts }: { artifacts?: ProductionArtifact[] }) {
  if (!artifacts?.length) return null;
  return (
    <div className="llm-production-message-artifacts" aria-label="本轮生成的产物">
      {artifacts.map((artifact) => (
        <a
          key={artifact.id}
          className="llm-production-message-file"
          href={productionDownload(artifact)}
          download={artifact.name}
          aria-label={`下载 ${artifact.name}，${productionBytes(artifact.size)}`}
        >
          {artifact.mimeType.startsWith('image/') ? (
            <Image size={20} aria-hidden="true" />
          ) : (
            <File size={20} aria-hidden="true" />
          )}
          <span className="llm-production-message-file-info">
            <strong>{artifact.name}</strong>
            <span>
              {productionBytes(artifact.size)} · {productionExpiry(artifact)}
            </span>
          </span>
          <Download size={18} aria-hidden="true" />
        </a>
      ))}
    </div>
  );
}
