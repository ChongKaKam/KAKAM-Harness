import { useState, type FormEvent } from 'react';
import { Plus, ArrowUpRight, Trash2, BookOpen } from 'lucide-react';
import { api, patch, post, remove } from '../../client/api';
import { ColorPickerButton, usePatternColors } from '../../client/color-pattern';
import { useWorkspace } from '../../client/context';
import { PageHeader, Empty, Modal, ErrorNote, useLoad, Spinner } from '../../client/components';
export function PromptsPage() {
  const colors = usePatternColors();
  const { navigate, setDraft, notify } = useWorkspace();
  const { data, error, reload } = useLoad(() =>
    api<{ id: string; title: string; content: string; colorSlot: number | null }[]>('/prompts'),
  );
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await post('/prompts', Object.fromEntries(new FormData(e.currentTarget)));
      setAdding(false);
      reload();
      notify('提示词已收藏');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="YOUR PROMPT LIBRARY"
        title="好的开始，值得收藏"
        description="把常用的表达和提问方式，整理成属于自己的小工具。"
        action={
          <button
            className="button primary"
            onClick={() => {
              setFormError('');
              setAdding(true);
            }}
          >
            <Plus size={16} />
            新建提示词
          </button>
        }
      />
      <ErrorNote text={error} />
      {!data ? (
        !error && <Spinner />
      ) : !data.length ? (
        <Empty title="收藏你的第一个提示词">
          为经常做的事情存一个好开头，例如润色文章、阅读代码或规划学习。
        </Empty>
      ) : (
        <div className="prompt-grid">
          {data.map((p) => (
            <article
              className="panel prompt-card pattern-card"
              key={p.id}
              style={colors.style({ key: p.id, slot: p.colorSlot })}
            >
              <div className="row">
                <BookOpen size={19} />
                <span className="grow" />
                <ColorPickerButton
                  label={p.title}
                  value={p.colorSlot}
                  colorKey={p.id}
                  onChange={async (colorSlot) => {
                    await patch(`/prompts/${p.id}/color`, { colorSlot });
                    reload();
                  }}
                />
                <button
                  className="icon-button"
                  aria-label={`删除 ${p.title}`}
                  onClick={async () => {
                    if (!confirm('删除这个提示词？')) return;
                    try {
                      await remove(`/prompts/${p.id}`);
                      reload();
                    } catch (e) {
                      notify((e as Error).message);
                    }
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <h3>{p.title}</h3>
              <p>{p.content}</p>
              <button
                className="button"
                onClick={() => {
                  setDraft(p.content);
                  navigate('chat');
                }}
              >
                用于新对话
                <ArrowUpRight size={15} />
              </button>
            </article>
          ))}
        </div>
      )}
      {adding && (
        <Modal title="新建提示词" close={() => !busy && setAdding(false)}>
          <form onSubmit={save}>
            <label>
              名称
              <input name="title" required maxLength={80} placeholder="例如：我的写作伙伴" />
            </label>
            <label>
              提示词内容
              <textarea
                name="content"
                required
                maxLength={20000}
                rows={7}
                placeholder="你希望 AI 怎样帮助你？"
              />
            </label>
            <ErrorNote text={formError} />
            <div className="modal-actions">
              <button className="button primary" disabled={busy}>
                {busy ? '保存中…' : '保存提示词'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
