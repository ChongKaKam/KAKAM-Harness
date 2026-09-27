import { useState, useEffect, useRef, type FormEvent, type ChangeEvent } from 'react';
import { ArrowRight, KeyRound, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { api, post, patch } from '../../client/api';
import { ErrorNote, Logo, PageHeader } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { User } from '../../shared/types';
import { UserAvatar, prepareAvatar } from '../../client/user-avatar';
export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [register, setRegister] = useState(false);
  const [migrate, setMigrate] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => {
    api<{ needsSetup: boolean }>('/auth/status')
      .then((d) => {
        setNeedsSetup(d.needsSetup);
        if (d.needsSetup) setRegister(true);
      })
      .catch(() => {});
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError('');
    try {
      const { user } = await post<{ user: User }>(
        migrate ? '/auth/migrate-email' : register ? '/auth/register' : '/auth/login',
        data,
      );
      onLogin(user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <section className="login-story">
        <div className="brand">
          <Logo />
          <strong>Drift Space</strong>
        </div>
        <div className="login-statement">
          <span className="eyebrow">A SPACE FOR YOUR IDEAS</span>
          <h1>
            给想法，
            <br />
            一个生长的空间。
          </h1>
          <p>
            从一个问题开始。
            <br />
            让灵感、知识和日常，在对话中连接。
          </p>
          <div className="orbit">
            <span>d</span>
            <i />
            <b />
            <em />
          </div>
        </div>
        <small>你的模型 · 你的对话 · 你的工作区</small>
      </section>
      <section className="login-form">
        <div className="login-box">
          <span className="welcome-symbol">
            <Sparkles size={24} />
          </span>
          <h2>{migrate ? '为旧账户绑定邮箱' : register ? '创建你的空间' : '欢迎回来'}</h2>
          <p className="muted">
            {migrate
              ? '使用原用户名和密码验证，绑定后改用邮箱登录，原有数据保留。'
              : register
                ? needsSetup
                  ? '首位注册用户将成为工作区管理员'
                  : '注册后即可进入工作区，模型由管理员授权'
                : '登录你的个人 AI 工作区'}
          </p>
          <form onSubmit={submit}>
            {migrate && (
              <label>
                旧用户名
                <input name="legacyUsername" required autoComplete="username" />
              </label>
            )}
            <label>
              邮箱
              <input
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                placeholder="you@example.com"
                required
                autoFocus
              />
            </label>
            {register && !migrate && (
              <label>
                显示名称
                <input
                  name="displayName"
                  required
                  maxLength={60}
                  autoComplete="nickname"
                  placeholder="我们该如何称呼你"
                />
              </label>
            )}
            <label>
              密码
              <input
                name="password"
                type="password"
                autoComplete={register && !migrate ? 'new-password' : 'current-password'}
                placeholder="输入密码"
                required
              />
            </label>
            <ErrorNote text={error} />
            <button className="button primary full" disabled={busy}>
              {busy
                ? '请稍候…'
                : migrate
                  ? '绑定邮箱并登录'
                  : register
                    ? '注册并进入'
                    : '进入工作区'}
              <ArrowRight size={17} />
            </button>
          </form>
          <button
            type="button"
            className="auth-switch"
            disabled={busy}
            onClick={() => {
              setRegister(!register);
              setMigrate(false);
              setError('');
            }}
          >
            {register ? '已有账户？登录' : '没有账户？立即注册'}
          </button>
          {!register && !needsSetup && (
            <button
              type="button"
              className="auth-switch"
              disabled={busy}
              onClick={() => {
                setMigrate(!migrate);
                setError('');
              }}
            >
              {migrate ? '返回邮箱登录' : '旧账户绑定邮箱'}
            </button>
          )}
          <div className="login-note">
            <ShieldCheck size={15} />
            密码加密保存，个人对话仅自己可见
          </div>
        </div>
        <small className="login-footer">
          Drift Space <span>一个安静、专注的思考空间</span>
        </small>
      </section>
    </div>
  );
}
export function AccountPage() {
  const { user, setUser, notify } = useWorkspace();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState('');
  const avatarFile = useRef<HTMLInputElement>(null);
  async function updateAvatar(file: File | null) {
    setAvatarBusy(true);
    setAvatarError('');
    try {
      const avatar = file ? await prepareAvatar(file) : null;
      const result = await patch<{ user: User }>('/auth/avatar', { avatar });
      setUser(result.user);
      notify(file ? '个人头像已更新' : '已恢复默认头像');
    } catch (e) {
      setAvatarError((e as Error).message);
    } finally {
      setAvatarBusy(false);
    }
  }
  function uploadAvatar(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void updateAvatar(file);
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const d = Object.fromEntries(new FormData(form));
    setBusy(true);
    setError('');
    try {
      const result = await patch<{ user: User }>('/auth/me', {
        displayName: d.displayName,
        email: d.email,
        currentPassword: d.currentPassword,
        ...(d.newPassword ? { newPassword: d.newPassword } : {}),
      });
      setUser(result.user);
      notify('账户设置已保存');
      form.reset();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHeader eyebrow="YOUR ACCOUNT" title="账户设置" description="管理个人资料与登录密码。" />
      <section className="panel account-panel">
        <div className="row">
          <UserAvatar user={user} size="large" />
          <div>
            <h3>{user.email ?? `${user.legacyUsername} · 待绑定邮箱`}</h3>
            <span className="badge">{user.role === 'admin' ? '管理员' : '普通用户'}</span>
          </div>
        </div>
        <div className="account-avatar-actions">
          <input
            ref={avatarFile}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="上传个人头像"
            onChange={uploadAvatar}
          />
          <button
            className="button"
            disabled={avatarBusy || busy}
            onClick={() => avatarFile.current?.click()}
          >
            <Upload size={15} />
            {avatarBusy ? '处理头像…' : '上传头像'}
          </button>
          <button
            className="button"
            disabled={avatarBusy || busy || !user.avatar}
            onClick={() => updateAvatar(null)}
          >
            恢复默认头像
          </button>
        </div>
        <p className="muted small avatar-upload-hint">
          PNG、JPEG 或 WebP，最大 10 MB。自动居中裁剪为方形并压缩保存。
        </p>
        <ErrorNote text={avatarError} />
        <form onSubmit={save}>
          <label>
            邮箱
            <input
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={user.email ?? ''}
              required
              maxLength={254}
              placeholder="you@example.com"
            />
          </label>
          <label>
            显示名称
            <input name="displayName" defaultValue={user.displayName} required maxLength={60} />
          </label>
          <div className="divider" />
          <h3 className="row">
            <KeyRound size={17} />
            修改密码
          </h3>
          <p className="muted small">
            修改邮箱或密码时需填写当前密码。更新后，其他设备将退出登录；新密码不修改时留空。
          </p>
          <label>
            当前密码
            <input name="currentPassword" type="password" autoComplete="current-password" />
          </label>
          <label>
            新密码
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              placeholder="输入新密码"
            />
          </label>
          <ErrorNote text={error} />
          <button className="button primary" disabled={busy || avatarBusy}>
            保存更改
          </button>
        </form>
      </section>
    </div>
  );
}
