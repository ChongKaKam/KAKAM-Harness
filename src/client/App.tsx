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
  MessageSquare,
  LayoutGrid,
} from 'lucide-react';
import { SettingsPage } from './settings';
import { APP_VERSION } from '../shared/version';
import { api, post } from './api';
import { useUi } from './ui-preferences';
import { ConversationList } from '../features/chat/conversation-list';
import { emptyChatDraft, useChatDrafts } from '../features/chat/use-chat-drafts';
import { Workspace } from './context';
import { clientFeatures } from './registry';
import { Logo, Spinner, PageHeader, ErrorNote } from './components';
import { UserAvatar } from './user-avatar';
import { Login } from '../features/auth/client';
import './mobile-navigation.css';
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
  const [mobileLayout, setMobileLayout] = useState(
    () => window.matchMedia('(max-width: 760px)').matches,
  );
  const [search, setSearch] = useState('');
  const { chatDraft, setChatDraft, resetChatDrafts } = useChatDrafts(
    user?.id,
    route.page === 'chat' ? route.id : undefined,
  );
  const [draftSkills, setDraftSkills] = useState<SelectedSkill[]>([]);
  const [toast, setToast] = useState('');
  const [toastPaused, setToastPaused] = useState(false);
  const [loadError, setLoadError] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarOpenerRef = useRef<HTMLElement | null>(null);
  const activeUserId = useRef<string | undefined>(undefined);
  activeUserId.current = user?.id;
  const openNavigation = useCallback(() => {
    sidebarOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMobileOpen(true);
  }, []);
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
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const change = () => {
      setMobileLayout(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!mobileLayout || !mobileOpen || !user) return;
    const opener = sidebarOpenerRef.current;
    const sidebar = sidebarRef.current;
    sidebar?.querySelector<HTMLButtonElement>('button')?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return;
      const controls = sidebar?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]',
      );
      const visible = Array.from(controls ?? []).filter(
        (control) => control.getClientRects().length > 0,
      );
      const first = visible[0];
      const last = visible.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', trapFocus);
    return () => {
      window.removeEventListener('keydown', trapFocus);
      if (opener instanceof HTMLElement && opener.isConnected && opener.getClientRects().length)
        opener.focus({ preventScroll: true });
    };
  }, [mobileLayout, mobileOpen, user?.id]);
  useEffect(() => {
    const layout = layoutRef.current;
    const viewport = window.visualViewport;
    if (!mobileLayout || checking || !user || !layout || !viewport) return;
    let frame = 0;
    const update = () => {
      const editing = document.activeElement?.matches(
        'input:not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"]',
      );
      const keyboardOpen = editing && viewport.scale === 1 && innerHeight - viewport.height > 120;
      layout.dataset.mobileKeyboard = keyboardOpen ? 'open' : 'closed';
      if (viewport.scale === 1)
        layout.style.setProperty(
          '--mobile-viewport-height',
          `${Math.round(viewport.height + viewport.offsetTop)}px`,
        );
      else layout.style.removeProperty('--mobile-viewport-height');
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener('resize', scheduleUpdate);
    viewport.addEventListener('scroll', scheduleUpdate);
    document.addEventListener('focusin', scheduleUpdate);
    document.addEventListener('focusout', scheduleUpdate);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', scheduleUpdate);
      viewport.removeEventListener('scroll', scheduleUpdate);
      document.removeEventListener('focusin', scheduleUpdate);
      document.removeEventListener('focusout', scheduleUpdate);
      delete layout.dataset.mobileKeyboard;
      layout.style.removeProperty('--mobile-viewport-height');
    };
  }, [mobileLayout, checking, user?.id]);
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
  const hasGenerating = conversations.some((conversation) => conversation.generating);
  useEffect(() => {
    if (!user || !hasGenerating) return;
    let disposed = false;
    const owner = user.id;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      api<Conversation[]>('/conversations')
        .then((rows) => {
          if (!disposed && activeUserId.current === owner) setConversations(rows);
        })
        .catch(() => {});
    }, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [user?.id, hasGenerating]);
  useEffect(() => {
    const change = () => {
      setRoute(readRoute());
      setMobileOpen(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', change);
    const shortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openNavigation();
        setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]'))
        setMobileOpen(false);
    };
    window.addEventListener('keydown', shortcut);
    return () => {
      window.removeEventListener('hashchange', change);
      window.removeEventListener('keydown', shortcut);
    };
  }, [openNavigation]);
  useEffect(() => {
    if (!toast || toastPaused) return;
    const timer = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(timer);
  }, [toast, toastPaused]);
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
          resetChatDrafts();
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
  const TopbarControls = current?.topbarComponent;
  async function logout() {
    try {
      await post('/auth/logout');
      setUser(undefined);
      resetChatDrafts();
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
        chatDraft,
        setChatDraft,
        draftSkills,
        setDraftSkills,
      }}
    >
      <div className="app-layout" ref={layoutRef}>
        {mobileOpen && (
          <button
            className="sidebar-shade"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          id="workspace-sidebar"
          ref={sidebarRef}
          className={`sidebar ${mobileOpen ? 'open' : ''}`}
          aria-label="主导航"
          inert={mobileLayout && !mobileOpen}
        >
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
              setChatDraft(emptyChatDraft, null);
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
        <main className="shell" inert={mobileLayout && mobileOpen}>
          <header className="topbar">
            <button
              className="icon-button mobile-only"
              aria-label="打开导航"
              aria-controls="workspace-sidebar"
              aria-expanded={mobileOpen}
              onClick={openNavigation}
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
            {TopbarControls && <TopbarControls />}
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
              available={available.filter(
                (f) =>
                  f.placement === 'settings' || f.settingsComponent || f.adminSettingsComponent,
              )}
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
        <nav className="mobile-navigation" aria-label="快捷导航" inert={mobileOpen}>
          {available.some((feature) => feature.manifest.id === 'chat') && (
            <button
              className={`mobile-navigation-item ${route.page === 'chat' ? 'active' : ''}`}
              aria-current={route.page === 'chat' && !mobileOpen ? 'page' : undefined}
              onClick={() => navigate('chat', route.page === 'chat' ? route.id : undefined)}
            >
              <MessageSquare size={20} aria-hidden="true" />
              <span>对话</span>
            </button>
          )}
          <button
            className={`mobile-navigation-item ${mobileOpen || (route.page !== 'chat' && route.page !== 'settings') ? 'active' : ''}`}
            aria-current={
              route.page !== 'chat' && route.page !== 'settings' && !mobileOpen ? 'page' : undefined
            }
            aria-controls="workspace-sidebar"
            aria-expanded={mobileOpen}
            onClick={openNavigation}
          >
            <LayoutGrid size={20} aria-hidden="true" />
            <span>工作区</span>
          </button>
          <button
            className={`mobile-navigation-item ${route.page === 'settings' ? 'active' : ''}`}
            aria-current={route.page === 'settings' && !mobileOpen ? 'page' : undefined}
            onClick={() => navigate('settings')}
          >
            <Settings size={20} aria-hidden="true" />
            <span>设置</span>
          </button>
        </nav>
        {toast && (
          <div
            role="status"
            className="toast"
            onMouseEnter={() => setToastPaused(true)}
            onMouseLeave={() => setToastPaused(false)}
            onFocusCapture={() => setToastPaused(true)}
            onBlurCapture={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setToastPaused(false);
            }}
          >
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
