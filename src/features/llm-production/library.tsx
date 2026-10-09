import { useEffect, useRef, useState } from 'react';
import { Download, Eye, File, Image, RefreshCw, Trash2, ArrowUpRight, Search } from 'lucide-react';
import { api, remove } from '../../client/api';
import { Empty, ErrorNote, Spinner } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { ProductionArtifact, ProductionList } from './types';
import { ProductionPreview } from './preview';
import {
  productionBytes,
  productionDate,
  productionDownload,
  productionExpiry,
  productionType,
} from './presentation';
import './production.css';

interface ProductionLibraryProps {
  conversationId?: string;
  groupId?: string;
  showSpace?: boolean;
  refreshed?: () => void;
}

export function ProductionLibrary(props: ProductionLibraryProps) {
  const { user } = useWorkspace();
  return (
    <ProductionLibraryContent
      key={`${user.id}:${props.conversationId ?? ''}:${props.groupId ?? ''}`}
      {...props}
    />
  );
}

function ProductionLibraryContent({
  conversationId,
  groupId,
  showSpace = false,
  refreshed,
}: ProductionLibraryProps) {
  const { navigate, notify } = useWorkspace();
  const [data, setData] = useState<ProductionList>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState<ProductionArtifact>();
  const [preview, setPreview] = useState<ProductionArtifact>();
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const focusAfterDelete = useRef(false);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirm) cancelDelete.current?.focus();
    else if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus();
  }, [confirm]);
  useEffect(() => {
    if (!loading && !deleting && focusAfterDelete.current) {
      focusAfterDelete.current = false;
      refreshButton.current?.focus();
    }
  }, [loading, deleting]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let valid = true;
    const query = new URLSearchParams();
    if (conversationId) query.set('conversationId', conversationId);
    else if (groupId) query.set('groupId', groupId);
    setLoading(true);
    setData(undefined);
    setError('');
    api<ProductionList>(`/llm-production/artifacts${query.size ? `?${query}` : ''}`)
      .then((result) => {
        if (valid) setData(result);
      })
      .catch((failure: Error) => {
        if (valid) setError(failure.message);
      })
      .finally(() => {
        if (valid) setLoading(false);
      });
    return () => {
      valid = false;
    };
  }, [conversationId, groupId, revision]);
  const reload = () => {
    deleteTrigger.current = null;
    setConfirm(undefined);
    setPreview(undefined);
    setLoading(true);
    setData(undefined);
    setRevision((value) => value + 1);
    refreshed?.();
  };
  const artifacts = data?.artifacts.filter((artifact) =>
    `${artifact.name} ${artifact.spaceName}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase()),
  );
  async function deleteArtifact() {
    if (!confirm || deleting) return;
    setDeleting(true);
    setError('');
    try {
      await remove(`/llm-production/artifacts/${encodeURIComponent(confirm.id)}`);
      window.dispatchEvent(new Event('drift:production-changed'));
      if (!mounted.current) return;
      notify('产物已删除');
      focusAfterDelete.current = true;
      reload();
    } catch (failure) {
      if (mounted.current) setError((failure as Error).message);
    } finally {
      if (mounted.current) setDeleting(false);
    }
  }
  return (
    <div className="llm-production-library">
      <div className="llm-production-library-toolbar">
        <label className="llm-production-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索产物名称"
            placeholder="搜索产物名称"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          ref={refreshButton}
          type="button"
          className="button"
          onClick={reload}
          disabled={loading || deleting}
        >
          <RefreshCw size={16} aria-hidden="true" />
          刷新
        </button>
      </div>
      {data?.space && (
        <div className="llm-production-space-summary">
          <strong>{data.space.name}</strong>
          <span>
            {data.space.kind === 'group' ? '分组共享 · 默认不过期' : '对话独享 · 到期自动清理'}
          </span>
          <span>
            {data.space.artifactCount} 个文件 · {productionBytes(data.space.size)}
          </span>
        </div>
      )}
      <ErrorNote text={error} />
      {confirm && (
        <div className="llm-production-delete-confirm" role="region" aria-label="确认删除产物">
          <p>删除「{confirm.name}」？文件将从产物空间移除，无法恢复。</p>
          <div className="llm-production-actions">
            <button
              ref={cancelDelete}
              type="button"
              className="button"
              onClick={() => setConfirm(undefined)}
              disabled={deleting}
            >
              取消
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void deleteArtifact()}
              disabled={deleting}
            >
              {deleting ? '删除中…' : '确认删除'}
            </button>
          </div>
        </div>
      )}
      {loading && <Spinner />}
      {!loading &&
        data &&
        (artifacts?.length ? (
          <div className="llm-production-list" aria-label="产物列表">
            {artifacts.map((artifact) => (
              <article className="llm-production-item" key={artifact.id}>
                <div className="llm-production-file-icon" aria-hidden="true">
                  {artifact.mimeType.startsWith('image/') ? (
                    <Image size={20} />
                  ) : (
                    <File size={20} />
                  )}
                </div>
                <div className="llm-production-file-info">
                  <h3 title={artifact.name}>{artifact.name}</h3>
                  <div className="llm-production-meta">
                    <span>{productionType(artifact)}</span>
                    <span>{productionBytes(artifact.size)}</span>
                    {showSpace && <span>{artifact.spaceName}</span>}
                  </div>
                  <div className="llm-production-meta">
                    <span>{productionDate(artifact.createdAt)} 生成</span>
                    <span>{productionExpiry(artifact)}</span>
                  </div>
                </div>
                <div className="llm-production-actions">
                  {artifact.conversationId && (
                    <button
                      type="button"
                      className="icon-button"
                      title="查看来源对话"
                      aria-label={`查看 ${artifact.name} 的来源对话`}
                      onClick={() =>
                        navigate(
                          'chat',
                          `${artifact.conversationId}${artifact.messageId ? `/${artifact.messageId}` : ''}`,
                        )
                      }
                    >
                      <ArrowUpRight size={18} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="button llm-production-preview-trigger"
                    aria-label={`预览 ${artifact.name}`}
                    onClick={() => setPreview(artifact)}
                  >
                    <Eye size={16} aria-hidden="true" />
                    预览
                  </button>
                  <a
                    className="button"
                    href={productionDownload(artifact)}
                    download={artifact.name}
                  >
                    <Download size={16} aria-hidden="true" />
                    下载
                  </a>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`删除 ${artifact.name}`}
                    title="删除产物"
                    onClick={(event) => {
                      deleteTrigger.current = event.currentTarget;
                      setConfirm(artifact);
                    }}
                    disabled={deleting}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty title={search ? '没有匹配的产物' : '还没有产物'}>
            {search
              ? '调整搜索关键词后再试。'
              : '在聊天中说明需要的文件格式或图片，模型生成后会出现在这里，可随时下载。'}
          </Empty>
        ))}
      {preview && <ProductionPreview artifact={preview} close={() => setPreview(undefined)} />}
    </div>
  );
}
