import { useState } from 'react';
import { api, post } from '../../client/api';
import { ErrorNote, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { WorkspaceContent } from './harness-document-content';
import type { Message } from '../../shared/types';
import type {
  WorkspaceApproval,
  WorkspaceDocument,
  WorkspaceRevision,
  WorkspaceView,
} from '../harness/types';

type Selection = { documentId: string; version: number };
const statuses = {
  pending: '待决定',
  preauthorized: '已预授权',
  approved: '已批准',
  rejected: '已拒绝',
};

function RevisionPreview({ path, selection }: { path: string; selection: Selection }) {
  const docPath = path + '/documents/' + selection.documentId + '?version=' + selection.version;
  const revision = useLoad(() => api<WorkspaceRevision>(docPath), [docPath]);
  return (
    <div className="harness-file-preview">
      <ErrorNote text={revision.error} />
      {revision.data ? (
        <WorkspaceContent kind={revision.data.kind} content={revision.data.content} />
      ) : (
        !revision.error && <Spinner />
      )}
    </div>
  );
}

export function Versions({
  path,
  doc,
  value,
  change,
}: {
  path: string;
  doc: WorkspaceDocument;
  value: number;
  change: (selection: Selection) => void;
}) {
  const versions = useLoad(
    () => api<number[]>(path + '/documents/' + doc.id + '/versions'),
    [path, doc.id, doc.version],
  );
  return (
    <>
      <label>
        授权版本
        <select
          value={value}
          onChange={(e) => change({ documentId: doc.id, version: Number(e.target.value) })}
        >
          {(versions.data ?? [doc.version]).map((v) => (
            <option key={v} value={v}>
              v{v}
            </option>
          ))}
        </select>
      </label>
      <ErrorNote text={versions.error} />
      <RevisionPreview key={value} path={path} selection={{ documentId: doc.id, version: value }} />
    </>
  );
}

function FileChoice({
  path,
  documents,
  selection,
  change,
}: {
  path: string;
  documents: WorkspaceDocument[];
  selection: Selection | undefined;
  change: (selection?: Selection) => void;
}) {
  const doc = documents.find((item) => item.id === selection?.documentId);
  return (
    <>
      <label>
        授权文件
        <select
          value={doc?.id ?? ''}
          onChange={(e) => {
            const found = documents.find((item) => item.id === e.target.value);
            change(found ? { documentId: found.id, version: found.version } : undefined);
          }}
        >
          <option value="">选择本会话文件</option>
          {documents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {doc && selection && (
        <Versions key={doc.id} path={path} doc={doc} value={selection.version} change={change} />
      )}
    </>
  );
}

function taskLabel(messages: Message[], message: Message) {
  const index = messages.findIndex((item) => item.id === message.id);
  const question = messages[index - 1];
  return (
    (question?.role === 'user' ? question.content : message.content).slice(0, 70) ||
    message.id.slice(0, 8)
  );
}

function AccessForm({
  path,
  view,
  messages,
  reload,
}: {
  path: string;
  view: WorkspaceView;
  messages: Message[];
  reload: () => void;
}) {
  const [mode, setMode] = useState<'request' | 'share' | 'grant'>('request');
  const [other, setOther] = useState('');
  const tasks = messages.filter((item) => item.role === 'assistant');
  const [chosenTask, setChosenTask] = useState('');
  const [grantTask, setGrantTask] = useState('');
  const task = chosenTask || tasks.at(-1)?.id;
  const [purpose, setPurpose] = useState('');
  const [selection, setSelection] = useState<Selection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  async function send() {
    setBusy(true);
    setError('');
    setSent('');
    try {
      if (mode === 'share') {
        await post(path + '/shares', { targetConversationId: other, ...selection });
        setSent('已分享，此版本现在可在目标对话的文档目录读取。');
      } else if (mode === 'grant') {
        await post(path + '/grants', {
          ...selection,
          taskId: grantTask.trim() || 'next',
          targetConversationId: other,
          purpose,
        });
        setSent('已登记此文件版本的授权。');
      } else {
        await post(path + '/requests', { sourceConversationId: other, taskId: task, purpose });
        setSent('已提交文件访问请求。');
      }
      setPurpose('');
      setSelection(undefined);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!view.sources.length)
    return <p className="muted">同一项目有其他工作对话时，可请求文件或授予指定版本的访问权。</p>;
  return (
    <div className="harness-form">
      <label>
        操作
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as typeof mode);
            setSent('');
          }}
        >
          <option value="request">向同项目对话请求文件</option>
          <option value="share">直接分享版本给一个对话</option>
          <option value="grant">向目标对话预授权</option>
        </select>
      </label>
      <label>
        {mode === 'request' ? '来源对话' : '目标对话'}
        <select value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="">选择对话</option>
          {view.sources.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </label>
      {mode === 'request' ? (
        <label>
          使用文件的任务
          <select value={task ?? ''} onChange={(e) => setChosenTask(e.target.value)}>
            {!tasks.length && <option value="">此会话还没有任务</option>}
            {tasks.map((item) => (
              <option key={item.id} value={item.id}>
                {taskLabel(messages, item)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <FileChoice
            path={path}
            documents={view.documents.filter((item) => item.scope === 'private')}
            selection={selection}
            change={setSelection}
          />
          {mode === 'grant' && (
            <>
              <label>
                目标任务 ID（可选）
                <input
                  value={grantTask}
                  onChange={(e) => setGrantTask(e.target.value)}
                  placeholder="留空时匹配下一次请求"
                />
              </label>
              <p className="muted">预授权仅供目标对话按下方用途使用一次，24 小时后到期。</p>
            </>
          )}
        </>
      )}
      {mode !== 'share' && (
        <label>
          使用目的
          <textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
      )}
      <button
        className="button"
        disabled={
          busy ||
          !other ||
          (mode !== 'share' && !purpose.trim()) ||
          (mode === 'request' ? !task : !selection)
        }
        onClick={send}
      >
        {mode === 'request' ? '提交访问请求' : mode === 'share' ? '分享此版本' : '确认预授权'}
      </button>
      <ErrorNote text={error} />
      {sent && <p role="status">{sent}</p>}
    </div>
  );
}

function Approval({
  path,
  conversationId,
  approval,
  view,
  messages,
  reload,
}: {
  path: string;
  conversationId: string;
  approval: WorkspaceApproval;
  view: WorkspaceView;
  messages: Message[];
  reload: () => void;
}) {
  const { conversations, navigate } = useWorkspace();
  const [selection, setSelection] = useState<Selection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [continueStatus, setContinueStatus] = useState('');
  const source = approval.sourceConversationId === conversationId;
  const tasks = messages.filter((item) => item.role === 'assistant');
  const [grantTask, setGrantTask] = useState('');
  const targetTask = approval.taskId === 'next' ? grantTask || tasks.at(-1)?.id : approval.taskId;
  async function useGrant() {
    if (!targetTask || !bound) return;
    setBusy(true);
    setError('');
    try {
      await post(path + '/requests', {
        ...bound,
        taskId: targetTask,
        sourceConversationId: approval.sourceConversationId,
        purpose: approval.purpose,
      });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    setBusy(true);
    setError('');
    try {
      await post('/conversations/' + conversationId + '/approvals/' + approval.id + '/continue');
      setContinueStatus('已确认继续请求，可在对话中查看进度。');
      window.dispatchEvent(new Event('drift:harness-resumed'));
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const bound =
    approval.documentId && approval.version
      ? { documentId: approval.documentId, version: approval.version }
      : undefined;
  const mayChoose = source && !bound;
  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setError('');
    try {
      const result = await post<{ resumeError?: string }>(
        path + '/requests/' + approval.id + '/decision',
        { decision, ...(mayChoose && decision === 'approve' ? selection : {}) },
      );
      if (result.resumeError) setError(result.resumeError);
      if (!source && decision === 'approve')
        window.dispatchEvent(new Event('drift:harness-resumed'));
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = (id: string) => conversations.find((item) => item.id === id)?.title ?? '项目对话';
  return (
    <article className="harness-entry harness-form">
      <div className="harness-row">
        <strong>{approval.name ?? '请求文件'}</strong>
        <small>{statuses[approval.status]}</small>
      </div>
      <div>
        {title(approval.sourceConversationId)} → {title(approval.targetConversationId)}
      </div>
      <small>
        {approval.taskId === 'next' ? '下次匹配的任务' : '任务 ' + approval.taskId.slice(0, 8)}
        {approval.version !== null && ' · v' + approval.version}
        {approval.expiresAt && ' · 到期 ' + new Date(approval.expiresAt).toLocaleString()}
      </small>
      <p>{approval.purpose}</p>
      {approval.status === 'preauthorized' && !source && (
        <>
          {approval.taskId === 'next' && (
            <label>
              使用预授权的任务
              <select value={targetTask ?? ''} onChange={(e) => setGrantTask(e.target.value)}>
                {!tasks.length && <option value="">此会话还没有任务</option>}
                {tasks.map((task) => (
                  <option value={task.id} key={task.id}>
                    {taskLabel(messages, task)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="button" disabled={busy || !targetTask || !bound} onClick={useGrant}>
            为此任务使用预授权
          </button>
        </>
      )}
      {approval.status === 'pending' && (
        <>
          {mayChoose && (
            <FileChoice
              path={path}
              documents={view.documents.filter((item) => item.scope === 'private')}
              selection={selection}
              change={setSelection}
            />
          )}
          {source && bound && (
            <details>
              <summary>预览授权版本</summary>
              <RevisionPreview path={path} selection={bound} />
            </details>
          )}
          <div className="harness-actions">
            <button className="button" onClick={() => decide('reject')} disabled={busy}>
              拒绝请求
            </button>
            {(source || bound) && (
              <button
                className="button primary"
                disabled={busy || (!bound && !selection)}
                onClick={() => decide('approve')}
              >
                批准此版本
              </button>
            )}
            {!source && !bound && (
              <button
                className="button"
                onClick={() => navigate('chat', approval.sourceConversationId)}
              >
                到来源对话选择文件
              </button>
            )}
          </div>
        </>
      )}
      {approval.status === 'approved' && source && (
        <button className="button" onClick={() => navigate('chat', approval.targetConversationId)}>
          返回目标对话
        </button>
      )}
      {approval.status === 'approved' && !source && (
        <button className="button" disabled={busy} onClick={resume}>
          继续原任务
        </button>
      )}
      {continueStatus && <p role="status">{continueStatus}</p>}
      <ErrorNote text={error} />
    </article>
  );
}

export function WorkspaceAccess({
  path,
  conversationId,
  messages,
  view,
  reload,
}: {
  path: string;
  conversationId: string;
  messages: Message[];
  view: WorkspaceView;
  reload: () => void;
}) {
  return (
    <div className="harness-form">
      {view.approvals.map((approval) => (
        <Approval
          key={approval.id}
          path={path}
          conversationId={conversationId}
          approval={approval}
          messages={messages}
          view={view}
          reload={reload}
        />
      ))}
      <AccessForm path={path} messages={messages} view={view} reload={reload} />
    </div>
  );
}
