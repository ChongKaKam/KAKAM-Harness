import { useEffect, useRef, useState } from 'react';
import { BookmarkPlus, Check } from 'lucide-react';
import { api } from '../../client/api';
import { ErrorNote, Modal, Spinner } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { MemoryItem, MemoryRememberPreview } from '../../shared/memory';
import './remember.css';

export function RememberDialog({
  conversationId,
  messageId,
  close,
}: {
  conversationId: string;
  messageId: string;
  close(): void;
}) {
  const { navigate, notify } = useWorkspace();
  const [preview, setPreview] = useState<MemoryRememberPreview>();
  const [content, setContent] = useState('');
  const [scope, setScope] = useState<'user' | 'group'>('user');
  const [saved, setSaved] = useState<MemoryItem>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const confirmation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPreview(undefined);
    api<MemoryRememberPreview>('/memory/v1/remember', {
      method: 'POST',
      body: JSON.stringify({ conversationId, messageId }),
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        setPreview(value);
        setContent(value.content);
        setScope(value.groupId ? 'group' : 'user');
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conversationId, messageId, revision]);
  useEffect(() => () => confirmation.current?.abort(), []);

  function openMemory(pending = false) {
    close();
    navigate('memory', pending ? 'pending' : undefined);
  }
  async function confirm() {
    if (!preview || saving || !content.trim()) return;
    const controller = new AbortController();
    confirmation.current = controller;
    setSaving(true);
    setError('');
    try {
      const value = await api<MemoryItem>(`/memory/v1/remember/${preview.id}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ scope, content: content.trim() }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setSaved(value);
      notify(
        value.scope === 'user'
          ? value.status === 'active'
            ? '该摘要已存在于长期记忆'
            : '已保存到待纳入长期记忆'
          : '已保存到当前分组记忆',
      );
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    } finally {
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <Modal
      title="Remember it · 记住这条回复"
      className="memory-remember"
      close={() => {
        if (!saving) close();
      }}
    >
      {saved ? (
        <div className="memory-remember-result">
          <p role="status">
            <Check size={18} aria-hidden="true" />
            {saved.scope === 'user'
              ? saved.status === 'active'
                ? '该摘要已存在于长期记忆'
                : '已保存，待纳入长期记忆'
              : '已保存到当前分组记忆'}
          </p>
          <p className="memory-remember-caption">
            {saved.scope === 'user'
              ? saved.status === 'active'
                ? '已保留原记忆的纳入状态，无需重复纳入。'
                : '在记忆管理中确认纳入后，才会用于后续对话。'
              : '索引完成后，同一分组的对话可按相关性召回这条记忆。'}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={close}>
              继续对话
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => openMemory(saved.scope === 'user' && saved.status !== 'active')}
            >
              {saved.scope === 'user' && saved.status !== 'active' ? '前往待纳入记忆' : '查看记忆'}
            </button>
          </div>
        </div>
      ) : (
        <form
          className="memory-remember-form"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <p className="memory-remember-caption">
            从当前回复提炼摘要，保留原文来源。确认保存前可以修改内容和记忆范围。
          </p>
          {loading && (
            <div className="memory-remember-loading" role="status">
              <Spinner />
              <span>正在提炼值得记住的内容…</span>
            </div>
          )}
          <ErrorNote text={error} />
          {!loading && !preview && (
            <div className="memory-remember-error-actions">
              <button
                type="button"
                className="button"
                onClick={() => setRevision((value) => value + 1)}
              >
                重新提炼
              </button>
              <button
                type="button"
                className="button"
                onClick={() => {
                  close();
                  navigate('settings', 'memory');
                }}
              >
                打开记忆设置
              </button>
            </div>
          )}
          {preview && (
            <>
              <p className="memory-remember-caption">摘要模型：{preview.modelName}</p>
              {preview.inputTruncated && (
                <p className="memory-remember-caption">
                  本次回复较长，摘要仅使用部分原文；保存仍关联完整来源消息。
                </p>
              )}
              <label>
                记忆摘要
                <textarea
                  value={content}
                  rows={5}
                  maxLength={8000}
                  required
                  disabled={saving}
                  onChange={(event) => setContent(event.target.value)}
                />
              </label>
              <div className="memory-remember-evidence" aria-label="摘要原文依据">
                <h3>原文依据</h3>
                {preview.sources
                  .filter((source) => !!source.evidence)
                  .map((source) => (
                    <blockquote key={source.messageId}>
                      <span>
                        {source.messageId === preview.messageId ? '当前回复' : '本轮提问'}
                      </span>
                      <p>{source.evidence}</p>
                    </blockquote>
                  ))}
                <p className="memory-remember-caption">保存后可从记忆条目回溯本轮提问和回复。</p>
              </div>
              <label>
                保存到
                <select
                  value={scope}
                  disabled={saving}
                  onChange={(event) => setScope(event.target.value as 'user' | 'group')}
                >
                  <option value="user">全局长期记忆（待纳入）</option>
                  <option value="group" disabled={!preview.groupId}>
                    当前分组记忆{!preview.groupId && '（对话尚未分组）'}
                  </option>
                </select>
              </label>
              <p className="memory-remember-caption">
                {scope === 'user'
                  ? '先保存为待纳入；在记忆管理中明确确认后参与跨对话召回。'
                  : '保存到当前对话所属分组，仅供该分组的对话使用。'}
              </p>
            </>
          )}
          <div className="modal-actions">
            <button type="button" className="button" disabled={saving} onClick={close}>
              取消
            </button>
            {preview && (
              <button type="submit" className="button primary" disabled={saving || !content.trim()}>
                <BookmarkPlus size={16} />
                {saving ? '保存中…' : scope === 'user' ? '确认保存为待纳入' : '确认保存到分组'}
              </button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
