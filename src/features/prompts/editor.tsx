import type { Skill, SkillFile } from '../skills/types';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Sparkles, X, LoaderCircle } from 'lucide-react';
import { api, patch, post } from '../../client/api';
import { ErrorNote, Modal } from '../../client/components';
import { normalizeTags, promptLimits, type PromptPreferences } from './types';

export function PromptEditor({
  card,
  preferences,
  knownTags,
  close,
  saved,
}: {
  card?: Skill;
  preferences: PromptPreferences;
  knownTags: string[];
  close: () => void;
  saved: () => void;
}) {
  const [title, setTitle] = useState(card?.title ?? '');
  const [content, setContent] = useState(card?.content ?? '');
  const [files, setFiles] = useState<SkillFile[]>(card?.files ?? []);
  const [description, setDescription] = useState(card?.description ?? '');
  const [tags, setTags] = useState(card?.tags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function combinedTags(value: string) {
    const next = normalizeTags([...tags, ...value.split(/[,，\n]/)]);
    if (next.length > promptLimits.tags) throw new Error(`最多添加 ${promptLimits.tags} 个标签`);
    if (next.some((tag) => tag.length > promptLimits.tag))
      throw new Error(`每个标签最多 ${promptLimits.tag} 个字符`);
    return next;
  }
  function addTags(value: string) {
    try {
      setTags(combinedTags(value));
      setTagDraft('');
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || generating) return;
    setError('');
    let next: string[];
    try {
      next = combinedTags(tagDraft);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setBusy(true);
    try {
      const input = {
        title,
        content,
        description,
        tags: next,
        files,
        ...(card ? { version: card.version } : {}),
      };
      if (card) await patch(`/skills/${card.id}`, input);
      else await post('/skills', input);
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setGenerating(true);
    setError('');
    setStatus('');
    try {
      const result = await api<{ description: string }>('/skills/description', {
        method: 'POST',
        body: JSON.stringify({ title, content }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setDescription(result.description);
        setStatus('简介已生成，可继续修改后保存');
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      request.current = null;
      setGenerating(false);
    }
  }
  return (
    <Modal
      title={card ? '编辑Skill' : '新建Skill'}
      close={() => {
        if (!busy) {
          request.current?.abort();
          close();
        }
      }}
    >
      <form className="prompts-editor" onSubmit={save}>
        <label>
          名称
          <input
            autoFocus
            required
            maxLength={promptLimits.title}
            value={title}
            disabled={busy || generating}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：我的写作伙伴"
          />
        </label>
        <label>
          主指令（SKILL.md）
          <textarea
            aria-label="主指令（SKILL.md）"
            required
            maxLength={promptLimits.content}
            rows={7}
            value={content}
            disabled={busy || generating}
            onChange={(e) => setContent(e.target.value)}
            placeholder="你希望 AI 怎样帮助你？"
          />
        </label>
        <div className="prompts-description-heading">
          <span>卡片简介</span>
          <button
            type="button"
            className="button"
            disabled={
              busy || generating || !preferences.summaryModelId || !title.trim() || !content.trim()
            }
            onClick={() => void generate()}
          >
            {generating ? (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            ) : (
              <Sparkles size={14} aria-hidden="true" />
            )}
            {generating ? '正在生成…' : '生成简介'}
          </button>
        </div>
        <textarea
          aria-label="卡片简介"
          maxLength={promptLimits.description}
          rows={3}
          value={description}
          disabled={busy || generating}
          onChange={(e) => {
            setDescription(e.target.value);
            setStatus('');
          }}
          placeholder="说明这个技能能做什么，以及什么情况下应该使用。"
        />
        <p className="prompts-editor-hint">
          {preferences.summaryModelId
            ? '按需生成，正文修改后可重新生成简介。'
            : '可手动填写；在设置 → Skill 库中选择模型后，即可生成简介。'}{' '}
          {description.length}/{promptLimits.description}
        </p>
        <p role="status" className="prompts-editor-hint">
          {generating ? '模型正在撰写简介…' : status}
        </p>
        <label className="prompts-tag-label" htmlFor="prompt-tags">
          标签{' '}
          <span>
            最多 {promptLimits.tags} 个，每个 {promptLimits.tag} 字符
          </span>
        </label>
        <div className="prompts-tag-entry">
          <input
            id="prompt-tags"
            value={tagDraft}
            disabled={busy}
            placeholder="输入标签，按回车或逗号添加"
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
                e.preventDefault();
                addTags(tagDraft);
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            disabled={busy || !tagDraft.trim()}
            aria-label="添加标签"
            onClick={() => addTags(tagDraft)}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="prompts-tags">
          {tags.map((tag) => (
            <button
              type="button"
              className="prompts-tag"
              key={tag.toLocaleLowerCase()}
              disabled={busy}
              aria-label={`移除标签 ${tag}`}
              onClick={() => setTags(tags.filter((item) => item !== tag))}
            >
              {tag}
              <X size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
        {!!knownTags.length && (
          <div className="prompts-tag-suggestions">
            <span>已有标签</span>
            {knownTags
              .filter(
                (tag) =>
                  !tags.some(
                    (selected) => selected.toLocaleLowerCase() === tag.toLocaleLowerCase(),
                  ),
              )
              .slice(0, 12)
              .map((tag) => (
                <button
                  type="button"
                  className="prompts-tag"
                  disabled={busy || tags.length >= promptLimits.tags}
                  key={tag}
                  onClick={() => addTags(tag)}
                >
                  {tag}
                  <Plus size={12} aria-hidden="true" />
                </button>
              ))}
          </div>
        )}
        <fieldset className="skills-files" disabled={busy || generating}>
          <legend>参考文档与模板</legend>
          <p className="prompts-editor-hint">
            在主指令中引用文件路径，模型会在需要时读取。支持 references/ 和 assets/ 下的文本文件。
          </p>
          {files.map((file, index) => (
            <div className="skills-file" key={index}>
              <label>
                文件路径
                <input
                  aria-label={`文件路径 ${index + 1}`}
                  value={file.path}
                  maxLength={160}
                  placeholder="references/style.md"
                  required
                  onChange={(e) =>
                    setFiles(
                      files.map((f, i) => (i === index ? { ...f, path: e.target.value } : f)),
                    )
                  }
                />
              </label>
              <label>
                文件内容
                <textarea
                  aria-label={`文件内容 ${index + 1}`}
                  rows={5}
                  maxLength={40000}
                  value={file.content}
                  onChange={(e) =>
                    setFiles(
                      files.map((f, i) => (i === index ? { ...f, content: e.target.value } : f)),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="button"
                onClick={() => setFiles(files.filter((_, i) => i !== index))}
              >
                移除文件 {index + 1}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button"
            disabled={files.length >= 16}
            onClick={() => setFiles([...files, { path: '', content: '' }])}
          >
            添加参考文件
          </button>
        </fieldset>
        <ErrorNote text={error} />
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              request.current?.abort();
              close();
            }}
          >
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || generating || !title.trim() || !content.trim()}
          >
            {busy ? '保存中…' : '保存Skill'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
