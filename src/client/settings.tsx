import { useState } from 'react';
import { Info, Puzzle, LockKeyhole, ArrowLeft, GitBranch, ExternalLink } from 'lucide-react';
import type { ClientFeature } from './registry';
import { useWorkspace } from './context';
import { Logo, PageHeader, ErrorNote, Spinner } from './components';
import { APP_VERSION } from '../shared/version';
import { patch } from './api';
import type { FeatureManifest } from '../shared/types';
export function SettingsPage({
  available,
  tab = 'preferences',
}: {
  available: ClientFeature[];
  tab?: string;
}) {
  const { user, features, refresh, navigate } = useWorkspace();
  const feature = available.find((f) => f.manifest.id === tab);
  const Component = feature?.settingsComponent ?? feature?.component;
  const personal = available.filter((f) => !f.manifest.adminOnly && !f.settingsParent);
  const admin = available.filter((f) => f.manifest.adminOnly && !f.settingsParent);
  const link = (id: string, name: string, Icon: ClientFeature['icon']) => (
    <button
      key={id}
      className={tab === id || feature?.settingsParent === id ? 'active' : ''}
      aria-current={tab === id ? 'page' : undefined}
      onClick={() => navigate('settings', id)}
    >
      <Icon size={17} />
      {name}
    </button>
  );
  return (
    <div className="settings-page">
      <header className="settings-heading">
        <div>
          <span className="eyebrow">YOUR SPACE, YOUR WAY</span>
          <h1>设置</h1>
        </div>
        <button className="button" onClick={() => navigate('chat')}>
          <ArrowLeft size={15} />
          返回对话
        </button>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="设置分类">
          <div className="settings-nav-group">
            {personal.map((f) => link(f.manifest.id, f.settingsLabel ?? f.manifest.name, f.icon))}
            {link('about', '相关信息', Info)}
          </div>
          {user.role === 'admin' && (
            <div className="settings-nav-group">
              <span className="nav-label">管理员</span>
              {admin.map((f) => link(f.manifest.id, f.manifest.name, f.icon))}
              {link('features', '功能与插件', Puzzle)}
            </div>
          )}
        </nav>
        <div className="settings-content" key={tab}>
          {Component ? (
            <Component />
          ) : tab === 'about' ? (
            <AboutPage />
          ) : tab === 'features' && user.role === 'admin' ? (
            <FeaturesPage features={features} refresh={refresh} />
          ) : !features.length ? (
            <Spinner />
          ) : (
            <div className="page">
              <PageHeader
                eyebrow="SETTINGS"
                title="此设置不可用"
                description="此功能尚未启用，或你的账户没有访问权限。"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function AboutPage() {
  return (
    <div className="page about-page">
      <PageHeader
        eyebrow="ABOUT DRIFT SPACE"
        title="相关信息"
        description="一个安静、专注的个人 AI 空间。"
      />
      <section className="panel about-card">
        <div className="brand">
          <Logo />
          <div>
            <h2>Drift Space</h2>
            <p className="muted">版本 {APP_VERSION}</p>
          </div>
        </div>
        <div className="divider" />
        <h3>你的模型，你的空间</h3>
        <p>连接自己的模型服务，在对话中整理想法、探索知识。</p>
        <dl>
          <div>
            <dt>项目源码</dt>
            <dd>
              <a
                className="project-link"
                href="https://github.com/ChongKaKam/KAKAM-Harness"
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitBranch size={17} aria-hidden="true" />
                <span>ChongKaKam/KAKAM-Harness</span>
                <ExternalLink size={14} aria-hidden="true" />
              </a>
            </dd>
          </div>
          <div>
            <dt>个人数据</dt>
            <dd>
              聊天记录、Color
              Pattern、组件颜色和头像保存在服务器；字体大小仅保存在当前设备，并按账户区分。
            </dd>
          </div>
          <div>
            <dt>模型调用</dt>
            <dd>发送的消息与图片会交给你选择的模型来源处理。</dd>
          </div>
          <div>
            <dt>用量统计</dt>
            <dd>普通用户仅可查看自己的用量，管理员可查看全部用户。</dd>
          </div>
        </dl>
        <div className="kernel-note">KH-Kernel · Powered by Cordis</div>
      </section>
    </div>
  );
}
function FeaturesPage({
  features,
  refresh,
}: {
  features: FeatureManifest[];
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  return (
    <div className="page">
      <PageHeader
        eyebrow="WORKSPACE CAPABILITIES"
        title="让工作区，随你生长"
        description="基础能力组成稳定的底座，插件为日常工作带来更多可能。"
      />
      <ErrorNote text={error} />
      <div className="notice">
        <Puzzle size={17} />
        停用插件会同步移除入口并停止其 API；已有数据保留，重新启用后恢复。
      </div>
      <div className="feature-groups">
        {(['core', 'plugin'] as const).map((kind) => (
          <section className="feature-group" key={kind} aria-labelledby={`features-${kind}`}>
            <header className="feature-group-heading">
              <span className="eyebrow">{kind === 'core' ? 'CORE' : 'PLUGIN'}</span>
              <h2 id={`features-${kind}`}>
                {kind === 'core' ? '基础能力' : '进阶能力'}
                <span className="badge">{features.filter((f) => f.kind === kind).length}</span>
              </h2>
              <p>
                {kind === 'core' ? '平台运行所需，始终保持启用。' : '按需启用，扩展你的工作区。'}
              </p>
            </header>
            <div className="panel feature-list">
              {features
                .filter((f) => f.kind === kind)
                .map((f) => (
                  <div className="feature-row" key={f.id}>
                    <span className="feature-icon">
                      {f.kind === 'core' ? <LockKeyhole size={19} /> : <Puzzle size={19} />}
                    </span>
                    <div className="grow">
                      <h3>{f.name}</h3>
                      <p>{f.description}</p>
                    </div>
                    <div className="feature-controls">
                      <small className="muted">v{f.version}</small>
                      {kind === 'core' ? (
                        <span className="feature-required">始终启用</span>
                      ) : (
                        <button
                          className={`toggle ${f.enabled ? 'on' : ''}`}
                          role="switch"
                          aria-checked={f.enabled}
                          aria-label={`${f.name}开关`}
                          disabled={f.kind === 'core' || !!busy}
                          onClick={async () => {
                            setBusy(f.id);
                            setError('');
                            try {
                              await patch(`/features/${f.id}`, { enabled: !f.enabled });
                              await refresh();
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy('');
                            }
                          }}
                        />
                      )}
                    </div>
                  </div>
                ))}
              {!features.some((f) => f.kind === kind) && (
                <p className="feature-empty muted">
                  暂无{kind === 'core' ? '基础能力' : '进阶插件'}
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
      <div className="kernel-note">
        KH-Kernel <span>·</span> Powered by Cordis <span>·</span> Core + Feature Plugins
      </div>
    </div>
  );
}
