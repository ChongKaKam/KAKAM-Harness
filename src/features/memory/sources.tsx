import { ExternalLink } from 'lucide-react';
import { api } from '../../client/api';
import { ErrorNote, Modal, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { MemoryItem, MemorySourceExcerpt } from '../../shared/memory';

export function MemorySources({ item, close }: { item: MemoryItem; close(): void }) {
  const { navigate } = useWorkspace();
  const { data, error } = useLoad(
    () => api<MemorySourceExcerpt[]>(`/memory/v1/memories/${item.id}/sources`),
    [item.id],
  );
  return (
    <Modal title="记忆来源与原文" className="memory-editor memory-source-dialog" close={close}>
      <p className="memory-caption">
        来源保留消息标识与正文校验信息。原消息被修改或删除后，会明确标记，避免把新内容当作保存时的证据。
      </p>
      <ErrorNote text={error} />
      {!data && !error && <Spinner />}
      <div className="memory-source-list">
        {data?.map((source, index) => (
          <article className="memory-source-entry" key={`${source.messageId}-${index}`}>
            <div className="memory-item-heading">
              <strong>
                {source.conversationTitle || `对话 ${source.conversationId.slice(0, 8)}`}
              </strong>
              <span className="memory-caption">
                {
                  { available: '原文可追溯', changed: '原消息已修改', unavailable: '来源不可访问' }[
                    source.status
                  ]
                }
              </span>
            </div>
            <p className="memory-caption">
              {source.role === 'assistant'
                ? '助手回答'
                : source.role === 'user'
                  ? '用户输入'
                  : '来源消息'}{' '}
              · 消息 {source.messageId.slice(0, 8)} · 校验 {source.hash.slice(0, 12)}
            </p>
            {source.excerpt && (
              <blockquote className="memory-source-excerpt">{source.excerpt}</blockquote>
            )}
            {source.status !== 'available' && source.evidence && (
              <>
                <p className="memory-caption">保存时的证据摘录</p>
                <blockquote className="memory-source-excerpt">{source.evidence}</blockquote>
              </>
            )}
            {source.inputTruncated && (
              <p className="memory-caption">
                此处仅展示原文前 4,000 字符，完整内容请打开来源对话。
              </p>
            )}
            {source.status !== 'unavailable' && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  close();
                  navigate('chat', `${source.conversationId}/${source.messageId}`);
                }}
              >
                <ExternalLink size={15} />
                打开来源对话
              </button>
            )}
          </article>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="button" onClick={close}>
          关闭来源
        </button>
      </div>
    </Modal>
  );
}
