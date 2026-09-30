import type { SelectedSkill } from '../features/skills/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Menu,
  Plus,
  Search,
  LogOut,
  Settings,
  X,
  Pencil,
  PanelLeftClose,
  Check,
} from 'lucide-react';
import { SettingsPage } from './settings';
import { APP_VERSION } from '../shared/version';
import { api, post } from './api';
import { useUi } from './ui-preferences';
import { ConversationList } from '../features/chat/conversation-list';
import { Workspace } from './context';
import { clientFeatures } from './registry';
import { Logo, Spinner, PageHeader, ErrorNote } from './components';
import { UserAvatar } from './user-avatar';
import { Login } from '../features/auth/client';
import type {
  Conversation,
  ConversationGroup,
  FeatureManifest,
  Model,
  User,
} from '../shared/types';
const settingsRoutes = new Set(['preferences', 'auth', 'models', 'users', 'features']);
function destination(page: string, id?: string) {
  return settingsRoutes.has(page) ? { page: 'settings', id: page } : { page, id };
}
function readRoute() {
  const [page, id] = window.location.hash.replace(/^#\/?/, '').split('/');
  return destination(page || 'chat', id || undefined);
}
export default function App() {
  const { activate } = useUi();
  const [user, setUser] = useState<User>();
  const [checking, setChecking] = useState(true);
  const [models, setModels] = useState<Model[]>([]);
  const [features, setFeatures] = useState<FeatureManifest[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<ConversationGroup[]>([]);
  const [route, setRoute] = useState(readRoute);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [draftSkills, setDraftSkills] = useState<SelectedSkill[]>([]);
  const [toast, setToast] = useState('');
  const [loadError, setLoadError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const activeUserId = useRef<string | undefined>(undefined);
  activeUserId.current = user?.id;
  useEffect(() => {
    api<{ user: User }>('/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => {})
      .finally(() => setChecking(false));
    const unauthorized = () => setUser(undefined);
    window.addEventListener('kh:unauthorized', unauthorized);
    return () => window.removeEventListener('kh:unauthorized', unauthorized);
  }, []);
  useEffect(() => activate(user?.id), [user?.id, activate]);
  const refresh = useCallback(async () => {
    if (!user) return;
    const [m, f, c, g] = await Promise.all([
      api<Model[]>('/models'),
      api<FeatureManifest[]>('/features'),
      api<Conversation[]>('/conversations'),
      api<ConversationGroup[]>('/conversation-groups'),
    ]);
    // Ignore responses started under a previous account after logout / account switching.
    if (activeUserId.current !== user.id) return;
    setModels(m);
    setFeatures(f);
    setConversations(c);
    setGroups(g);
    setLoadError('');
  }, [user]);
  useEffect(() => {
    if (!user) return;
    refresh().catch((e) => setLoadError(e.message));
    const timer = setInterval(() => refresh().catch(() => {}), 30000);
    const resume = () => {
      if (document.visibilityState !== 'hidden') void refresh().catch(() => {});
    };
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [refresh, user]);
  useEffect(() => {
    const change = () => {
      setRoute(readRoute());
      setMobileOpen(false);
    };
    window.addEventListener('hashchange', change);
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setMobileOpen(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', shortcut);
    return () => {
      window.removeEventListener('hashchange', change);
      window.removeEventListener('keydown', shortcut);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = useCallback((page: string, conversationId?: string) => {
    const next = destination(page, conversationId);
    window.location.hash = `/${next.page}${next.id ? `/${next.id}` : ''}`;
    setMobileOpen(false);
  }, []);
  if (checking)
    return (
      <div className="app-loading">
        <Logo />
        <Spinner />
      </div>
    );
  if (!user)
    return (
      <Login
        onLogin={(u) => {
          setUser(u);
          setFeatures([]);
          setConversations([]);
          setGroups([]);
          setSearch('');
          setModels([]);
          setDraft('');
          setDraftSkills([]);
          navigate('chat');
        }}
      />
    );
  const available = clientFeatures.filter(
    (c) =>
      features.some((f) => f.id === c.manifest.id && f.enabled) &&
      (!c.manifest.adminOnly || user.role === 'admin'),
  );
  const current = available.find((f) => f.manifest.id === route.page);
  const Component = current?.component;
  async function logout() {
    try {
      await post('/auth/logout');
      setUser(undefined);
      setDraft('');
      setDraftSkills([]);
      setConversations([]);
      setGroups([]);
      setSearch('');
      setModels([]);
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  return (
    <Workspace.Provider
      value={{
        user,
        setUser,
        models,
        features,
        conversations,
        refresh,
        navigate,
        notify: setToast,
        conversationId: route.id,
        draft,
        setDraft,
        draftSkills,
        setDraftSkills,
      }}
    >
      <div className="app-layout">
        {mobileOpen && (
          <button
            className="sidebar-shade"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside className={`sidebar ${mobileOpen ? 'open' : ''}`} aria-label="主导航">
          <div className="brand">
            <Logo />
            <div>
              <strong>Drift Space</strong>
              <small>个人 AI 工作区</small>
            </div>
            <button
              className="icon-button mobile-only"
              aria-label="收起导航"
              onClick={() => setMobileOpen(false)}
            >
              <PanelLeftClose size={18} />
            </button>
          </div>
          <button
            className="new-chat"
            onClick={() => {
              setDraft('');
              setDraftSkills([]);
              navigate('chat');
            }}
          >
            <Plus size={18} />
            新对话
            <span className="grow" />
            <Pencil size={14} />
          </button>
          <div className="sidebar-search">
            <Search size={16} />
            <input
              ref={searchRef}
              aria-label="搜索对话"
              placeholder="搜索对话"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd>⌘ K</kbd>
          </div>
          <div className="side-scroll">
            <div className="nav-label">工作区</div>
            <nav aria-label="工作区">
              {available
                .filter((f) => f.placement === 'workspace')
                .map((f) => (
                  <button
                    key={f.manifest.id}
                    className={`nav-item ${route.page === f.manifest.id ? 'active' : ''}`}
                    onClick={() => navigate(f.manifest.id)}
                  >
                    <f.icon size={17} />
                    {f.manifest.name}
                    {f.manifest.kind === 'plugin' && <span className="nav-plugin">插件</span>}
                  </button>
                ))}
            </nav>
            <ConversationList
              key={user.id}
              groups={groups}
              search={search}
              activeId={route.page === 'chat' ? route.id : undefined}
            />
            {available.some((f) => f.placement === 'statistics') && (
              <>
                <div className="nav-label">统计</div>
                <nav aria-label="统计">
                  {available
                    .filter((f) => f.placement === 'statistics')
                    .map((f) => (
                      <button
                        key={f.manifest.id}
                        className={`nav-item ${route.page === f.manifest.id ? 'active' : ''}`}
                        onClick={() => navigate(f.manifest.id)}
                      >
                        <f.icon size={17} />
                        {f.manifest.name}
                      </button>
                    ))}
                </nav>
              </>
            )}
          </div>
          <div className="sidebar-footer">
            <button
              className={`profile ${route.page === 'settings' ? 'active' : ''}`}
              aria-label="打开设置"
              title="设置"
              onClick={() => navigate('settings')}
            >
              <UserAvatar user={user} />
              <span className="grow">
                <strong>{user.displayName}</strong>
                <small>{user.role === 'admin' ? '工作区管理员' : '工作区成员'}</small>
              </span>
              <Settings size={16} />
            </button>
            <div className="sidebar-bottom">
              <span>
                <span className="status-dot" />
                个人空间
              </span>
              <button aria-label="退出登录" title="退出登录" onClick={logout}>
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </aside>
        <main className="shell">
          <header className="topbar">
            <button
              className="icon-button mobile-only"
              aria-label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              <Menu size={20} />
            </button>
            <div className="breadcrumb">
              <span>
                {route.page === 'settings'
                  ? 'Drift Space'
                  : current?.placement === 'statistics'
                    ? '统计'
                    : '我的工作区'}
              </span>
              <span>/</span>
              <strong>
                {route.page === 'settings' ? '设置' : (current?.manifest.name ?? '工作区')}
              </strong>
            </div>
            <span className="grow" />
            <span className="topbar-note">
              <span className="status-dot" />
              属于你的思考空间
            </span>
            <span className="version-label">V {APP_VERSION}</span>
          </header>
          {loadError && (
            <div className="shell-error">
              <ErrorNote text={loadError} />
              <button
                className="button"
                onClick={() => refresh().catch((e) => setLoadError(e.message))}
              >
                重新加载
              </button>
            </div>
          )}
          {route.page === 'settings' ? (
            <SettingsPage
              available={available.filter((f) => f.placement === 'settings' || f.settingsComponent)}
              tab={route.id}
            />
          ) : Component ? (
            <Component />
          ) : features.length ? (
            <div className="page">
              <PageHeader
                eyebrow="WORKSPACE"
                title="此功能暂不可用"
                description="功能可能已被停用，或你的账户没有访问权限。"
              />
              <button className="button" onClick={() => navigate('chat')}>
                返回对话
              </button>
            </div>
          ) : (
            !loadError && <Spinner />
          )}
        </main>
        {toast && (
          <div role="status" className="toast">
            <Check size={16} />
            {toast}
            <button aria-label="关闭提示" onClick={() => setToast('')}>
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </Workspace.Provider>
  );
}
