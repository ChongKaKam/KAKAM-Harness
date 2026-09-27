import { UserAvatar } from '../../client/user-avatar';
import { useState, type FormEvent } from 'react';
import { Plus, ShieldCheck } from 'lucide-react';
import { api, post, patch } from '../../client/api';
import { PageHeader, Modal, ErrorNote, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { User } from '../../shared/types';
export function UsersPage() {
  const { user, notify } = useWorkspace();
  const { data, error, reload } = useLoad(() => api<User[]>('/admin/users'));
  const [editing, setEditing] = useState<User | 'new'>();
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const v = Object.fromEntries(form);
    setBusy(true);
    setFormError('');
    try {
      if (editing === 'new') await post('/admin/users', v);
      else
        await patch(`/admin/users/${editing!.id}`, {
          displayName: v.displayName,
          email: v.email,
          ...(editing!.id !== user.id ? { role: v.role, active: form.has('active') } : {}),
          ...(v.password ? { password: v.password } : {}),
        });
      setEditing(undefined);
      reload();
      notify('用户已保存');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="PEOPLE & ACCESS"
        title="用户管理"
        description="为每个人留一个专注的空间，并授予恰当的访问权限。"
        action={
          <button
            className="button primary"
            onClick={() => {
              setFormError('');
              setEditing('new');
            }}
          >
            <Plus size={16} />
            添加用户
          </button>
        }
      />
      <div className="notice">
        <ShieldCheck size={17} />
        <span>
          用户的对话相互隔离。管理员管理账户、模型授权与全局用量，不通过此页面读取其他人的对话。
        </span>
      </div>
      <ErrorNote text={error} />
      {!data ? (
        !error && <Spinner />
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="row">
                      <UserAvatar user={u} />
                      <div>
                        <strong>
                          {u.displayName}
                          {u.id === user.id && <span className="muted"> · 你</span>}
                        </strong>
                        <small>{u.email ?? `${u.legacyUsername} · 待绑定邮箱`}</small>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className="badge">{u.role === 'admin' ? '管理员' : '普通用户'}</span>
                  </td>
                  <td>
                    <span className={`status ${u.active ? '' : 'off'}`}>
                      {u.active ? '正常' : '已停用'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="button"
                      onClick={() => {
                        setFormError('');
                        setEditing(u);
                      }}
                    >
                      管理
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal
          title={editing === 'new' ? '添加用户' : '管理用户'}
          close={() => !busy && setEditing(undefined)}
        >
          <form onSubmit={save}>
            <label>
              邮箱
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                defaultValue={editing === 'new' ? '' : (editing.email ?? '')}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </label>
            <label>
              显示名称
              <input
                name="displayName"
                required
                maxLength={60}
                defaultValue={editing === 'new' ? '' : editing.displayName}
              />
            </label>
            <label>
              {editing === 'new' ? '初始密码' : '重置密码（留空不修改）'}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required={editing === 'new'}
                placeholder="输入新密码"
              />
            </label>
            {(editing === 'new' || editing.id !== user.id) && (
              <>
                <label>
                  角色
                  <select name="role" defaultValue={editing === 'new' ? 'user' : editing.role}>
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                  </select>
                </label>
                {editing !== 'new' && (
                  <label className="check-row">
                    <input name="active" type="checkbox" defaultChecked={editing.active} />
                    允许登录
                  </label>
                )}
              </>
            )}
            <ErrorNote text={formError} />
            <div className="modal-actions">
              <button className="button primary" disabled={busy}>
                {busy ? '保存中…' : '保存用户'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
