import { useState } from 'react';
import { FileText, Plus, RefreshCw } from 'lucide-react';
import { api, patch, post } from '../../client/api';
import { ErrorNote, Modal, Spinner, useLoad } from '../../client/components';
import { Markdown } from '../../client/markdown';
import type { Message } from '../../shared/types';
import type { WorkspaceDocument, WorkspaceRevision, WorkspaceView } from '../harness/types';
import { WorkspaceAccess, Versions } from './harness-workspace-access';
import { WorkspaceContent } from './harness-document-content';

const scopes = { private: '会话私有', project: '项目共享', granted: '指定版本授权' };
const prefStatuses = { pending: '待纳入', active: '已纳入', withdrawn: '已撤出' };

export default function HarnessWorkspace({
  conversationId,
  messages,
  initialTab,
  close,
}: {
  conversationId: string;
  messages: Message[];
  initialTab: 'docs' | 'access';
  close: () => void;
}) {
  const path = `/conversations/${conversationId}/workspace`;
  const view = useLoad(() => api<WorkspaceView>(path), [path]);
  const [tab, setTab] = useState<'docs' | 'access' | 'preferences'>(initialTab);
  const [selection, select] = useState('');
  const doc = view.data?.documents.find((item) => item.id === selection);
  return (
    <Modal className="harness-workspace" title="对话工作区" close={close}>
      <nav className="harness-tabs" aria-label="工作区页面">
        {(
          [
            ['docs', '文档'],
            ['access', '访问授权'],
            ['preferences', '个人偏好'],
          ] as const
        ).map(([id, title]) => (
          <button className="button" aria-pressed={tab === id} key={id} onClick={() => setTab(id)}>
            {title}
          </button>
        ))}
        <button className="icon-button" aria-label="刷新工作区" onClick={view.reload}>
          <RefreshCw size={16} />
        </button>
      </nav>
      <ErrorNote text={view.error} />
      {!view.data && !view.error && <Spinner />}
      {view.data && tab === 'docs' && (
        <div className="harness-document-layout">
          <aside aria-label="工作区文档" className="harness-document-index">
            <button className="button" onClick={() => select('new')}>
              <Plus size={16} /> 新建文档
            </button>
            {view.data.documents.map((item) => (
              <button
                key={item.id}
                className="harness-file"
                aria-pressed={item.id === selection}
                onClick={() => select(item.id)}
              >
                <FileText size={16} />
                <span>
                  {item.name}
                  <small>
                    {scopes[item.scope]} · v{item.version}
                  </small>
                </span>
              </button>
            ))}
          </aside>
          <div className="harness-editor">
            {selection === 'new' ? (
              <NewDocument
                path={path}
                created={(id) => {
                  select(id);
                  view.reload();
                }}
              />
            ) : doc ? (
              <DocumentVersions
                key={doc.id + ':' + doc.version}
                path={path}
                doc={doc}
                documents={view.data.documents}
                canPublish={!!view.data.groupId}
                reload={view.reload}
              />
            ) : (
              <p className="muted">选择文档可查看正文和版本。</p>
            )}
          </div>
        </div>
      )}
      {view.data && tab === 'access' && (
        <WorkspaceAccess
          path={path}
          conversationId={conversationId}
          messages={messages}
          view={view.data}
          reload={view.reload}
        />
      )}
      {view.data && tab === 'preferences' && (
        <Preferences path={path} items={view.data.preferences} reload={view.reload} />
      )}
    </Modal>
  );
}

function NewDocument({ path, created }: { path: string; created: (id: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'document' | 'handoff'>('document');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    setError('');
    try {
      const item = await post<WorkspaceRevision>(path + '/documents', {
        name: name.trim(),
        kind,
        content,
      });
      created(item.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="harness-form">
      <label>
        类型
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="document">文档</option>
          <option value="handoff">交接文档</option>
        </select>
      </label>
      <label>
        文件名
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 交接.md" />
      </label>
      <label>
        正文
        <textarea
          rows={8}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setPreview(false);
          }}
        />
      </label>
      <div className="harness-actions">
        <button className="button" disabled={!content} onClick={() => setPreview(!preview)}>
          预览正文
        </button>
        <button
          className="button primary"
          disabled={busy || !name.trim() || !content.trim()}
          onClick={save}
        >
          保存到本会话
        </button>
      </div>
      {preview && <Markdown content={content} />}
      <ErrorNote text={error} />
    </div>
  );
}

function DocumentVersions({
  path,
  doc,
  canPublish,
  documents,
  reload,
}: {
  path: string;
  doc: WorkspaceDocument;
  canPublish: boolean;
  documents: WorkspaceDocument[];
  reload: () => void;
}) {
  const docPath = path + '/documents/' + doc.id;
  const versions = useLoad(() => api<number[]>(docPath + '/versions'), [docPath, doc.version]);
  const [version, setVersion] = useState(doc.version);
  return (
    <div className="harness-form">
      <h3>{doc.name}</h3>
      <label>
        查看版本
        <select value={version} onChange={(e) => setVersion(Number(e.target.value))}>
          {(versions.data ?? [doc.version]).map((v) => (
            <option key={v} value={v}>
              v{v}
            </option>
          ))}
        </select>
      </label>
      <ErrorNote text={versions.error} />
      <RevisionEditor
        key={version}
        path={path}
        doc={doc}
        version={version}
        documents={documents}
        canPublish={canPublish}
        reload={reload}
      />
    </div>
  );
}

function RevisionEditor({
  path,
  doc,
  version,
  canPublish,
  documents,
  reload,
}: {
  path: string;
  doc: WorkspaceDocument;
  version: number;
  canPublish: boolean;
  documents: WorkspaceDocument[];
  reload: () => void;
}) {
  const docPath = path + '/documents/' + doc.id;
  const revision = useLoad(
    () => api<WorkspaceRevision>(docPath + '?version=' + version),
    [docPath, version],
  );
  const [edit, setEdit] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [references, setReferences] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const editable =
    version === doc.version &&
    doc.kind !== 'artifact' &&
    (doc.scope === 'private' ||
      (doc.scope === 'project' &&
        doc.kind === 'instructions' &&
        doc.sourceConversationId === null));
  async function save(publish: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (publish)
        await post(path + '/publish', {
          documentId: doc.id,
          version,
          references: Object.entries(references).map(([documentId, version]) => ({
            documentId,
            version,
          })),
          ...(edit === undefined ? {} : { content: edit }),
        });
      else await patch(docPath, { baseVersion: version, content: edit });
      setEdit(undefined);
      setPublishing(false);
      setNotice(publish ? '选定版本已发布到本项目。' : '已保存新版本。');
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const content = edit ?? revision.data?.content ?? '';
  return (
    <>
      <ErrorNote text={error || revision.error} />
      {!revision.data && !revision.error && <Spinner />}
      {revision.data && (
        <>
          {edit !== undefined && !publishing ? (
            <label>
              编辑正文
              <textarea
                rows={8}
                value={edit}
                disabled={busy}
                onChange={(e) => setEdit(e.target.value)}
              />
            </label>
          ) : (
            <div className="harness-file-preview">
              <WorkspaceContent kind={doc.kind} content={content} />
            </div>
          )}
          {publishing ? (
            <>
              <p>
                确认将上方内容发布给本项目的其他对话。
                {edit !== undefined ? '编辑后的内容会作为新版本保存。' : `本次发布 v${version}。`}
              </p>
              <details className="harness-share-references">
                <summary>一并发布的文件版本（{Object.keys(references).length}）</summary>
                {documents
                  .filter((item) => item.scope === 'private' && item.id !== doc.id)
                  .map((item) => (
                    <div key={item.id} className="harness-form">
                      <label className="harness-reference-choice">
                        <input
                          type="checkbox"
                          checked={references[item.id] !== undefined}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setReferences((current) => {
                              const next = { ...current };
                              if (checked) next[item.id] = item.version;
                              else delete next[item.id];
                              return next;
                            });
                          }}
                        />
                        {item.name}
                      </label>
                      {references[item.id] !== undefined && (
                        <Versions
                          path={path}
                          doc={item}
                          value={references[item.id]}
                          change={(value) =>
                            setReferences((current) => ({
                              ...current,
                              [value.documentId]: value.version,
                            }))
                          }
                        />
                      )}
                    </div>
                  ))}
              </details>
              <div className="harness-actions">
                <button className="button" disabled={busy} onClick={() => setPublishing(false)}>
                  取消发布
                </button>
                <button className="button primary" disabled={busy} onClick={() => save(true)}>
                  确认发布到项目
                </button>
              </div>
            </>
          ) : (
            <div className="harness-actions">
              {editable &&
                (edit === undefined ? (
                  <button className="button" onClick={() => setEdit(content)}>
                    编辑正文
                  </button>
                ) : (
                  <>
                    <button className="button" disabled={busy} onClick={() => setEdit(undefined)}>
                      取消编辑
                    </button>
                    <button
                      className="button primary"
                      disabled={busy || edit === revision.data.content}
                      onClick={() => save(false)}
                    >
                      保存新版本
                    </button>
                  </>
                ))}
              {canPublish && doc.scope === 'private' && (
                <button
                  className="button"
                  disabled={busy || !content.trim()}
                  onClick={() => {
                    setReferences({});
                    setPublishing(true);
                  }}
                >
                  预览项目发布
                </button>
              )}
            </div>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

function Preferences({
  path,
  items,
  reload,
}: {
  path: string;
  items: WorkspaceView['preferences'];
  reload: () => void;
}) {
  const [editId, setEditId] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(id?: string, decision?: 'admit' | 'withdraw') {
    setBusy(true);
    setError('');
    try {
      const base = path + '/preferences';
      const item = items.find((pref) => pref.id === (id ?? editId));
      if (decision && item)
        await post(base + '/' + item.id + '/decision', { version: item.version, decision });
      else if (item) await patch(base + '/' + item.id, { version: item.version, content });
      else await post(base, { content });
      if (!decision) {
        setEditId('');
        setContent('');
      }
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="harness-form">
      <p className="muted">纳入后的偏好可用于本人的新对话。修改正文后须重新纳入。</p>
      <label>
        {editId ? '修改偏好' : '新增个人偏好'}
        <textarea value={content} rows={3} onChange={(e) => setContent(e.target.value)} />
      </label>
      <div className="harness-actions">
        {editId && (
          <button
            className="button"
            disabled={busy}
            onClick={() => {
              setEditId('');
              setContent('');
            }}
          >
            取消编辑
          </button>
        )}
        <button className="button" disabled={busy || !content.trim()} onClick={() => save()}>
          保存为待纳入
        </button>
      </div>
      <ErrorNote text={error} />
      {items.map((item) => (
        <article key={item.id} className="harness-entry">
          <small>
            {prefStatuses[item.status]} · v{item.version}
          </small>
          <p>{item.content}</p>
          <div className="harness-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setEditId(item.id);
                setContent(item.content);
              }}
            >
              修改偏好
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => save(item.id, item.status === 'active' ? 'withdraw' : 'admit')}
            >
              {item.status === 'active' ? '撤出偏好' : '纳入个人偏好'}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
