import { useEffect, useRef, useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import { api } from '../../client/api';
import { ErrorNote, Modal, Spinner, Empty, useLoad } from '../../client/components';
import { Markdown } from '../../client/markdown';
import { useWorkspace } from '../../client/context';
import { skillLimits, type SelectedSkill, type Skill, type SkillSummary } from './types';
import './skills.css';

export function useChatSkills(conversationId?: string) {
  const { user, draftSkills, setDraftSkills } = useWorkspace();
  const [selected, setSelected] = useState<SelectedSkill[]>(draftSkills);
  const [loading, setLoading] = useState(!!conversationId);
  const [error, setError] = useState('');
  const requestRevision = useRef(0);
  const [reloadRevision, setReloadRevision] = useState(0);
  useEffect(() => {
    let valid = true;
    const revision = ++requestRevision.current;
    setError('');
    if (!conversationId) {
      setSelected(draftSkills);
      setLoading(false);
    } else {
      setSelected([]);
      setLoading(true);
      api<SelectedSkill[]>(`/conversations/${conversationId}/skills`)
        .then((items) => {
          if (valid && revision === requestRevision.current) setSelected(items);
        })
        .catch((e) => {
          if (valid && revision === requestRevision.current) setError(e.message);
        })
        .finally(() => {
          if (valid && revision === requestRevision.current) setLoading(false);
        });
    }
    return () => {
      valid = false;
    };
  }, [conversationId, user.id, reloadRevision]);
  return {
    selected,
    setSelected,
    loading,
    error,
    reload: () => setReloadRevision((v) => v + 1),
    restore(items: SelectedSkill[]) {
      requestRevision.current++;
      setLoading(false);
      setSelected(items);
    },
    accepted(items: SelectedSkill[]) {
      requestRevision.current++;
      setLoading(false);
      setSelected(items.filter((skill) => skill.scope === 'conversation'));
      setDraftSkills([]);
    },
  };
}

export function SkillChips({
  controls,
  disabled,
}: {
  controls: ReturnType<typeof useChatSkills>;
  disabled: boolean;
}) {
  return controls.selected.length ? (
    <div className="skills-chips" aria-label="已选 Skill">
      {controls.selected.map((skill) => (
        <div className="skills-chip" key={skill.id}>
          <BookOpen size={14} aria-hidden="true" />
          <span>
            {skill.title} · v{skill.version}
          </span>
          <select
            aria-label={`${skill.title} 生效范围`}
            value={skill.scope}
            disabled={disabled}
            onChange={(e) =>
              controls.setSelected((items) =>
                items.map((s) =>
                  s.id === skill.id ? { ...s, scope: e.target.value as SelectedSkill['scope'] } : s,
                ),
              )
            }
          >
            <option value="conversation">本对话</option>
            <option value="turn">仅本轮</option>
          </select>
          <button
            type="button"
            className="icon-button"
            aria-label={`移除 Skill ${skill.title}`}
            disabled={disabled}
            onClick={() => controls.setSelected((items) => items.filter((s) => s.id !== skill.id))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  ) : null;
}

export function SkillPicker({
  selected,
  change,
  close,
}: {
  selected: SelectedSkill[];
  change(items: SelectedSkill[]): void;
  close(): void;
}) {
  const { data, error, reload } = useLoad(() => api<SkillSummary[]>('/skills'));
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [preview, setPreview] = useState<Skill>();
  const [previewId, setPreviewId] = useState('');
  const [previewError, setPreviewError] = useState('');
  const previewRequest = useRef(0);
  useEffect(
    () => () => {
      previewRequest.current++;
    },
    [],
  );
  const visible = data?.filter(
    (skill) =>
      [skill.title, skill.description, ...skill.tags]
        .join('\n')
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()) &&
      (!tag || skill.tags.includes(tag)),
  );
  return (
    <Modal title="Skill 库" close={close} className="skills-picker-modal">
      <div
        className="skills-picker"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <p className="muted skills-picker-intro">
          选择后随下一条消息载入，可在输入栏调整生效范围。
        </p>
        <div className="skills-picker-controls">
          <label>
            搜索 Skill
            <input
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="名称、简介或标签"
            />
          </label>
          <label>
            标签
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">全部标签</option>
              {[...new Set(data?.flatMap((s) => s.tags))].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>
        <ErrorNote text={error || previewError} />
        {error && (
          <button className="button" onClick={reload}>
            重新加载
          </button>
        )}
        {!data && !error && <Spinner />}
        {data && !visible?.length && (
          <Empty title="没有找到 Skill">
            {query || tag ? '试试其他关键词或标签。' : '可以先在工作区的 Skill 库中新建。'}
          </Empty>
        )}
        {!!visible?.length && <p className="skills-picker-count">找到 {visible.length} 个 Skill</p>}
        <div className="skills-picker-list">
          {visible?.map((skill) => {
            const current = selected.find((s) => s.id === skill.id);
            return (
              <div className={`skills-picker-item${current ? ' is-selected' : ''}`} key={skill.id}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={!!current}
                    disabled={!current && selected.length >= skillLimits.selected}
                    onChange={() => {
                      if (previewId === skill.id) {
                        previewRequest.current++;
                        setPreviewId('');
                        setPreview(undefined);
                      }
                      change(
                        current
                          ? selected.filter((s) => s.id !== skill.id)
                          : [
                              ...selected,
                              {
                                id: skill.id,
                                title: skill.title,
                                version: skill.version,
                                scope: 'conversation',
                              },
                            ],
                      );
                    }}
                  />
                  <span>
                    {skill.title}
                    <small>
                      v{current?.version ?? skill.version} · {skill.fileCount} 个参考文件
                    </small>
                  </span>
                </label>
                <p>{skill.description || '暂无简介'}</p>
                {!!skill.tags.length && (
                  <div className="skills-picker-tags">
                    {skill.tags.map((value) => (
                      <span key={value}>{value}</span>
                    ))}
                  </div>
                )}
                <div className="skills-picker-actions">
                  <button
                    className="button"
                    type="button"
                    aria-label={`预览 ${skill.title}`}
                    aria-expanded={previewId === skill.id}
                    onClick={async () => {
                      if (previewId === skill.id) {
                        previewRequest.current++;
                        setPreviewId('');
                        setPreview(undefined);
                        return;
                      }
                      const request = ++previewRequest.current;
                      setPreviewId(skill.id);
                      setPreview(undefined);
                      setPreviewError('');
                      try {
                        const result = await api<Skill>(
                          `/skills/${skill.id}?version=${current?.version ?? skill.version}`,
                        );
                        if (request === previewRequest.current) setPreview(result);
                      } catch (e) {
                        if (request === previewRequest.current)
                          setPreviewError((e as Error).message);
                      }
                    }}
                  >
                    预览
                  </button>
                  {current && current.version !== skill.version && (
                    <button
                      className="button"
                      type="button"
                      onClick={() => {
                        if (previewId === skill.id) {
                          previewRequest.current++;
                          setPreviewId('');
                          setPreview(undefined);
                        }
                        change(
                          selected.map((s) =>
                            s.id === skill.id
                              ? { ...s, title: skill.title, version: skill.version }
                              : s,
                          ),
                        );
                      }}
                    >
                      更新到 v{skill.version}
                    </button>
                  )}
                </div>
                {previewId === skill.id && (
                  <section className="skills-preview" aria-label="Skill 预览">
                    {preview ? (
                      <>
                        <strong>
                          {preview.title} · v{preview.version}
                        </strong>
                        <Markdown content={preview.content} />
                        {preview.files.map((f) => (
                          <details key={f.path}>
                            <summary>{f.path}</summary>
                            <pre>{f.content}</pre>
                          </details>
                        ))}
                      </>
                    ) : (
                      !previewError && <Spinner />
                    )}
                  </section>
                )}
              </div>
            );
          })}
        </div>
        <div className="modal-actions skills-picker-footer">
          <span className="muted">
            已选 {selected.length} / {skillLimits.selected}
          </span>
          <button className="button primary" onClick={close}>
            完成选择
          </button>
        </div>
      </div>
    </Modal>
  );
}
