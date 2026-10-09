import { useEffect, useState } from 'react';
import { Check, ChevronDown, Download, Eye, File, Image, X } from 'lucide-react';
import { useWorkspace } from '../../client/context';
import type { ProductionArtifact, ProductionDelivery } from './types';
import {
  productionBytes,
  productionDownload,
  productionExpiry,
  productionPreviewKind,
} from './presentation';
import { ProductionImageThumbnail, ProductionPreview } from './preview';
import './production.css';

interface MessageArtifactsProps {
  artifacts?: ProductionArtifact[];
  delivery?: ProductionDelivery | null;
  messageStatus?: 'complete' | 'error' | 'cancelled' | 'streaming';
}

export function MessageArtifacts(props: MessageArtifactsProps) {
  const { user } = useWorkspace();
  return <MessageArtifactsContent key={user.id} {...props} />;
}

function MessageArtifactsContent({ artifacts, delivery, messageStatus }: MessageArtifactsProps) {
  const [preview, setPreview] = useState<ProductionArtifact>();
  useEffect(() => {
    if (preview && !artifacts?.some((artifact) => artifact.id === preview.id))
      setPreview(undefined);
  }, [artifacts, preview]);
  if (!artifacts?.length && !delivery) return null;
  const completed = delivery?.items.filter((item) => item.status === 'complete').length ?? 0;
  const failed = delivery?.items.some((item) => item.status === 'failed');
  return (
    <div className="llm-production-message-artifacts" aria-label="本轮生成的产物">
      {delivery?.decision === 'clarify' && (
        <div className="llm-production-clarification">
          <strong role="status">产物需求待补充</strong>
          <p>{delivery.question || '请补充需要交付的文件或图片、内容与格式。'}</p>
        </div>
      )}
      {delivery?.decision === 'deliver' && (
        <details className="llm-production-delivery">
          <summary className="llm-production-delivery-summary">
            <File size={16} aria-hidden="true" />
            <strong>产物交付</strong>
            <span
              className="llm-production-delivery-progress"
              data-status={
                failed ? 'failed' : completed === delivery.items.length ? 'complete' : 'pending'
              }
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              完成 {completed}/{delivery.items.length}
              {failed
                ? ' · 部分失败'
                : messageStatus === 'cancelled'
                  ? ' · 已停止'
                  : messageStatus === 'error' && completed < delivery.items.length
                    ? ' · 未完成'
                    : ''}
            </span>
            <ChevronDown size={16} className="llm-production-delivery-chevron" aria-hidden="true" />
          </summary>
          <div
            className="llm-production-delivery-body"
            role="region"
            aria-label="产物交付清单"
            tabIndex={0}
          >
            <ol>
              {delivery.items.map((item) => (
                <li key={item.id} className="llm-production-delivery-item">
                  <div className="llm-production-delivery-item-heading">
                    <strong>{item.name}</strong>
                    <span className="llm-production-delivery-item-state" data-status={item.status}>
                      {item.status === 'complete' ? (
                        <Check size={14} aria-hidden="true" />
                      ) : item.status === 'failed' ? (
                        <X size={14} aria-hidden="true" />
                      ) : null}
                      {item.status === 'complete'
                        ? '已生成'
                        : item.status === 'failed'
                          ? '生成失败'
                          : messageStatus === 'cancelled'
                            ? '已停止'
                            : messageStatus === 'streaming'
                              ? '待生成'
                              : '未完成'}
                    </span>
                  </div>
                  <span className="llm-production-delivery-item-format">
                    {item.kind === 'image' ? '图片' : (item.format?.toUpperCase() ?? '文件')}
                  </span>
                  {item.brief && <p>{item.brief}</p>}
                  {item.error && <p className="llm-production-delivery-error">{item.error}</p>}
                  {item.status === 'complete' &&
                    !artifacts?.some((artifact) => artifact.id === item.artifactId) && (
                      <p className="llm-production-delivery-unavailable">文件已清理或暂不可用。</p>
                    )}
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}
      {artifacts?.map((artifact) => (
        <div key={artifact.id} className="llm-production-message-artifact">
          {productionPreviewKind(artifact) === 'image' && (
            <ProductionImageThumbnail artifact={artifact} preview={() => setPreview(artifact)} />
          )}
          <div className="llm-production-message-file-row">
            <a
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
            <button
              type="button"
              className="icon-button llm-production-preview-trigger"
              aria-label={`预览 ${artifact.name}`}
              title="预览产物"
              onClick={() => setPreview(artifact)}
            >
              <Eye size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
      {preview && <ProductionPreview artifact={preview} close={() => setPreview(undefined)} />}
    </div>
  );
}
