import { useEffect, useState } from 'react';
import { Download, Eye, File, Image, RefreshCw } from 'lucide-react';
import { ErrorNote, Modal, Spinner } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { Markdown } from '../../client/markdown';
import type { ProductionArtifact } from './types';
import {
  productionBytes,
  productionContent,
  productionDownload,
  productionExpiry,
  productionPreviewKind,
  productionType,
} from './presentation';
import './production.css';

const maxTextCharacters = 100_000;

interface PreviewContent {
  imageUrl?: string;
  text?: string;
  truncated?: boolean;
}

async function previewResponse(artifact: ProductionArtifact, signal: AbortSignal) {
  const response = await fetch(productionContent(artifact), { signal, cache: 'no-store' });
  signal.throwIfAborted();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('kh:unauthorized'));
    const body: unknown = await response.json().catch(() => null);
    const error =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `预览加载失败 (${response.status})`;
    throw new Error(error);
  }
  return response;
}

/** Bound decoded text before rendering, including responses split across UTF-8 characters. */
async function previewText(response: Response) {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length <= maxTextCharacters) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    return {
      text: text.slice(0, maxTextCharacters),
      truncated: text.length > maxTextCharacters,
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function usePreviewContent(artifact: ProductionArtifact) {
  const [content, setContent] = useState<PreviewContent>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const kind = productionPreviewKind(artifact);
  useEffect(() => {
    const changed = () => {
      // Clear stale content immediately, then recheck authorization and file availability.
      setContent(undefined);
      setError('');
      setRevision((value) => value + 1);
    };
    window.addEventListener('drift:production-changed', changed);
    let expiry: ReturnType<typeof setTimeout> | undefined;
    if (artifact.expiresAt) {
      const delay = Date.parse(artifact.expiresAt) - Date.now();
      expiry = setTimeout(changed, Math.max(0, Math.min(delay, 2_147_483_647)));
    }
    return () => {
      window.removeEventListener('drift:production-changed', changed);
      clearTimeout(expiry);
    };
  }, [artifact.expiresAt]);
  useEffect(() => {
    const abort = new AbortController();
    let imageUrl: string | undefined;
    setContent(undefined);
    setError('');
    if (kind === 'unsupported') return () => abort.abort();
    void (async () => {
      try {
        const response = await previewResponse(artifact, abort.signal);
        if (kind === 'image') {
          if (
            response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
            artifact.mimeType.toLowerCase()
          )
            throw new Error('此文件未返回有效的图片内容，请下载后检查。');
          const blob = await response.blob();
          abort.signal.throwIfAborted();
          imageUrl = URL.createObjectURL(blob);
          setContent({ imageUrl });
        } else {
          if (
            response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !==
            'text/plain'
          )
            throw new Error('此格式暂不支持在线预览，可下载原文件查看。');
          const result = await previewText(response);
          abort.signal.throwIfAborted();
          setContent(result);
        }
      } catch (failure) {
        if (!abort.signal.aborted)
          setError(failure instanceof Error ? failure.message : '预览加载失败，请稍后重试。');
      }
    })();
    return () => {
      abort.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [artifact.id, artifact.mimeType, kind, revision]);
  return { content, error, kind, reload: () => setRevision((value) => value + 1) };
}

export function ProductionImageThumbnail({
  artifact,
  preview,
}: {
  artifact: ProductionArtifact;
  preview: () => void;
}) {
  const { user } = useWorkspace();
  return (
    <ImageThumbnailContent
      key={`${user.id}:${artifact.id}`}
      artifact={artifact}
      preview={preview}
    />
  );
}

function ImageThumbnailContent({
  artifact,
  preview,
}: {
  artifact: ProductionArtifact;
  preview: () => void;
}) {
  const { content, error } = usePreviewContent(artifact);
  const [imageError, setImageError] = useState(false);
  useEffect(() => setImageError(false), [content?.imageUrl]);
  return (
    <button
      type="button"
      className="llm-production-image-thumbnail"
      aria-label={`放大 ${artifact.name}`}
      title={`放大查看 ${artifact.name}`}
      onClick={preview}
    >
      {content?.imageUrl && !imageError ? (
        <img src={content.imageUrl} alt={artifact.name} onError={() => setImageError(true)} />
      ) : (
        <span className="llm-production-thumbnail-placeholder">
          <Image size={24} aria-hidden="true" />
          <span>{error || imageError ? '图片暂不可用，点击查看' : '正在加载图片…'}</span>
        </span>
      )}
      <span className="llm-production-image-preview-hint">
        <Eye size={16} aria-hidden="true" />
        放大查看
      </span>
    </button>
  );
}

export function ProductionPreview({
  artifact,
  close,
}: {
  artifact: ProductionArtifact;
  close: () => void;
}) {
  const { user } = useWorkspace();
  return (
    <PreviewContentDialog key={`${user.id}:${artifact.id}`} artifact={artifact} close={close} />
  );
}

function PreviewContentDialog({
  artifact,
  close,
}: {
  artifact: ProductionArtifact;
  close: () => void;
}) {
  const { content, error, kind, reload } = usePreviewContent(artifact);
  const [imageError, setImageError] = useState(false);
  useEffect(() => setImageError(false), [content?.imageUrl]);
  return (
    <Modal title={`预览 · ${artifact.name}`} className="llm-production-preview" close={close}>
      <div className="llm-production-preview-toolbar">
        <div className="llm-production-preview-meta">
          <span>{productionType(artifact)}</span>
          <span>{productionBytes(artifact.size)}</span>
          <span>{productionExpiry(artifact)}</span>
        </div>
        <a className="button" href={productionDownload(artifact)} download={artifact.name}>
          <Download size={16} aria-hidden="true" />
          下载
        </a>
      </div>
      <ErrorNote text={error || (imageError ? '图片内容无法显示，可下载原文件查看。' : '')} />
      {(error || imageError) && (
        <button type="button" className="button" onClick={reload}>
          <RefreshCw size={16} aria-hidden="true" />
          重新加载
        </button>
      )}
      {!content && !error && kind !== 'unsupported' && <Spinner />}
      {kind === 'unsupported' && (
        <div className="llm-production-preview-unavailable">
          <File size={32} aria-hidden="true" />
          <p>此格式暂不支持在线预览。</p>
          <p>下载文件后，可使用相应应用查看完整内容。</p>
        </div>
      )}
      {content?.imageUrl && !imageError && (
        <div className="llm-production-preview-image">
          <img src={content.imageUrl} alt={artifact.name} onError={() => setImageError(true)} />
        </div>
      )}
      {content?.text !== undefined && (
        <>
          {content.truncated && (
            <p className="llm-production-preview-note" role="status">
              仅预览前 100,000 个字符。下载文件可查看完整内容。
            </p>
          )}
          <div className="llm-production-preview-text" tabIndex={0} aria-label="产物预览内容">
            {kind === 'markdown' ? (
              <Markdown content={content.text} streaming={content.truncated} />
            ) : (
              <pre>{content.text}</pre>
            )}
          </div>
          {artifact.mimeType === 'text/html' || artifact.mimeType === 'image/svg+xml' ? (
            <p className="llm-production-preview-note">以源码预览，下载后可在浏览器中打开。</p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
