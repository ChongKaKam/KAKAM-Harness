import { useState, type FormEvent } from 'react';
import { Copy, Download } from 'lucide-react';
import { api, post, remove } from '../../client/api';
import { copyText } from '../../client/clipboard';
import { ErrorNote, Modal, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { createCodexInstaller } from './codex-installer';
import './gateway.css';

type GatewayKey = { id: string; name: string; prefix: string; createdAt: number };
type GatewaySettings = { configured: boolean; keys: GatewayKey[] };

const adminPath = '/admin/openai-gateway';
const installerFile = 'install-codex-drift.sh';

export function GatewaySettingsPage() {
  const { user } = useWorkspace();
  if (user.role !== 'admin') return <ErrorNote text="需要管理员权限" />;
  return <GatewaySettingsContent key={user.id} />;
}

function IssuedKeyDialog({ deviceKey, close }: { deviceKey: string; close: () => void }) {
  const [feedback, setFeedback] = useState('');
  const [failure, setFailure] = useState('');
  const pasteScript = createCodexInstaller(location.origin);

  async function copy(value: string, label: string) {
    setFailure('');
    try {
      await copyText(value);
      setFeedback(`${label}已复制`);
    } catch {
      setFeedback('');
      setFailure('复制失败，请选中文本后手动复制。');
    }
  }

  function download() {
    setFailure('');
    try {
      const script = createCodexInstaller(location.origin, deviceKey);
      const url = URL.createObjectURL(new Blob([script], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = installerFile;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback('已生成带有设备密钥的安装文件。');
    } catch (error) {
      setFeedback('');
      setFailure((error as Error).message);
    }
  }

  return (
    <Modal title="保存设备密钥并配置 Codex" close={close} className="openai-gateway-install">
      <p className="small muted">完整设备密钥仅显示这一次。关闭前请保存密钥或下载安装文件。</p>
      <label className="openai-gateway-secret">
        开发机转发密钥
        <textarea
          aria-label="开发机转发密钥"
          readOnly
          value={deviceKey}
          rows={2}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
      <button className="button" onClick={() => void copy(deviceKey, '设备密钥')}>
        <Copy size={15} aria-hidden="true" />
        复制设备密钥
      </button>
      <section className="openai-gateway-install-section">
        <h3>在开发机安装</h3>
        <p className="small muted">
          适用于已安装 Codex CLI 的 macOS 或
          Linux。在下载目录运行以下命令，脚本会为当前用户完成配置。
        </p>
        <code className="openai-gateway-command">bash {installerFile}</code>
        <button className="button primary" onClick={download}>
          <Download size={15} aria-hidden="true" />
          下载已配置脚本
        </button>
        <p className="small muted">
          文件内含完整设备密钥。请只传到目标机器，并在安装后删除下载副本。
        </p>
      </section>
      <details className="openai-gateway-install-section">
        <summary>在远端终端粘贴安装</summary>
        <p className="small muted">
          将脚本粘贴到目标机的 Bash 或 Zsh，等到输入提示再粘贴设备密钥并回车。输入时密钥会隐藏。
        </p>
        <label className="openai-gateway-secret">
          终端安装脚本
          <textarea
            aria-label="终端安装脚本"
            readOnly
            rows={5}
            spellCheck={false}
            value={pasteScript}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
        <button className="button" onClick={() => void copy(pasteScript, '安装脚本')}>
          <Copy size={15} aria-hidden="true" />
          复制安装脚本
        </button>
      </details>
      <section className="openai-gateway-install-section">
        <h3>启动 Codex</h3>
        <code className="openai-gateway-command">~/.local/bin/codex-drift</code>
        <p className="small muted">
          在项目目录运行。若命令搜索路径包含 <code>~/.local/bin</code>，可直接输入{' '}
          <code>codex-drift</code>。 默认使用 CLI 选择的模型，也可追加 <code>-m 模型ID</code> 指定此
          OpenAI 密钥可用的模型。 独立配置保存在 <code>~/.codex-drift</code>。
        </p>
      </section>
      <ErrorNote text={failure} />
      {feedback && (
        <p className="small" role="status">
          {feedback}
        </p>
      )}
      <div className="modal-actions">
        <button className="button" onClick={close}>
          完成
        </button>
      </div>
    </Modal>
  );
}

function GatewaySettingsContent() {
  const { data, error, reload } = useLoad(() => api<GatewaySettings>(adminPath));
  const [name, setName] = useState('');
  const [issuedKey, setIssuedKey] = useState('');
  const [revoking, setRevoking] = useState<GatewayKey>();
  const [busy, setBusy] = useState<'save' | 'issue' | 'revoke' | null>(null);
  const [failure, setFailure] = useState('');
  const [feedback, setFeedback] = useState('');
  const baseUrl = `${location.origin}/api/openai/v1`;

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const apiKey = String(new FormData(form).get('apiKey') ?? '').trim();
    if (!apiKey) {
      setFeedback('');
      setFailure('请输入 OpenAI 密钥。');
      return;
    }
    setBusy('save');
    setFailure('');
    setFeedback('');
    try {
      await api(`${adminPath}/config`, { method: 'PUT', body: JSON.stringify({ apiKey }) });
      form.reset();
      setFeedback(data?.configured ? '已更换 OpenAI 密钥。' : '已保存 OpenAI 密钥。');
      reload();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !name.trim() || !data?.configured) return;
    setBusy('issue');
    setFailure('');
    setFeedback('');
    try {
      const result = await post<{ key: string }>(`${adminPath}/keys`, { name: name.trim() });
      setIssuedKey(result.key);
      setName('');
      reload();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    if (!revoking || busy) return;
    setBusy('revoke');
    setFailure('');
    setFeedback('');
    try {
      await remove(`${adminPath}/keys/${encodeURIComponent(revoking.id)}`);
      setFeedback(`已撤销「${revoking.name}」`);
      setRevoking(undefined);
      reload();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copyAddress() {
    setFailure('');
    try {
      await copyText(baseUrl);
      setFeedback('接口地址已复制。');
    } catch {
      setFeedback('');
      setFailure('复制失败，请选中地址后手动复制。');
    }
  }

  return (
    <div className="page openai-gateway">
      <PageHeader
        eyebrow="管理员设置"
        title="OpenAI API 转发"
        description="为每台开发机签发单独的设备密钥，请求通过本站转发到 OpenAI。"
        action={
          <a className="button" href="#/usage/openai-gateway">
            查看转发看板
          </a>
        }
      />
      <ErrorNote text={error} />
      {error && (
        <button className="button" onClick={reload}>
          重新加载
        </button>
      )}
      {!data && !error && <Spinner />}
      {data && (
        <>
          <section className="panel openai-gateway-panel">
            <h2>OpenAI 转发配置</h2>
            <p className="small muted">
              {data.configured
                ? '已配置。更换后，你已签发的设备密钥都会通过新的 OpenAI 密钥转发请求。'
                : '尚未配置。请保存此账户用于转发的 OpenAI API 密钥。'}
              {!data.configured &&
                data.keys.length > 0 &&
                '保存后，已有设备的后续请求也会使用这把密钥。'}
            </p>
            <form className="openai-gateway-form" onSubmit={saveConfig}>
              <label>
                {data.configured ? '新的 OpenAI API 密钥' : 'OpenAI API 密钥'}
                <input
                  type="password"
                  name="apiKey"
                  autoComplete="new-password"
                  maxLength={4096}
                  spellCheck={false}
                  required
                  disabled={!!busy}
                />
              </label>
              <button className="button primary" disabled={!!busy}>
                {busy === 'save'
                  ? '保存中…'
                  : data.configured
                    ? '更换 OpenAI 密钥'
                    : '保存 OpenAI 密钥'}
              </button>
            </form>
          </section>
          <section className="panel openai-gateway-panel">
            <h2>开发机接入</h2>
            <label>
              接口地址
              <input readOnly value={baseUrl} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <button className="button" onClick={() => void copyAddress()}>
              <Copy size={15} aria-hidden="true" />
              复制接口地址
            </button>
            {data.configured ? (
              <form className="openai-gateway-form" onSubmit={issue}>
                <label>
                  设备名称
                  <input
                    name="name"
                    placeholder="例如：工作笔记本"
                    maxLength={80}
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={!!busy}
                  />
                </label>
                <button className="button primary" disabled={!!busy || !name.trim()}>
                  {busy === 'issue' ? '签发中…' : '签发设备密钥'}
                </button>
              </form>
            ) : (
              <p className="small muted">保存 OpenAI 密钥后即可签发设备密钥。</p>
            )}
            <details>
              <summary>将已有的 codex-drift 配置导入 CC Switch</summary>
              <p className="small muted">
                在已配置的开发机上运行以下命令，再在装有 CC Switch 的电脑上打开生成的 HTML。
                文件包含这台设备的密钥。
              </p>
              <code className="openai-gateway-command">
                curl -fsSL https://drift.kakamlab.com/export-cc-switch.sh | bash
              </code>
              <a href="/export-cc-switch.sh" download>
                下载配置导出脚本
              </a>
            </details>
          </section>
          <section className="panel openai-gateway-panel">
            <h2>已签发的密钥</h2>
            {data.keys.length ? (
              <ul className="openai-gateway-keys">
                {data.keys.map((key) => (
                  <li key={key.id}>
                    <div>
                      <strong>{key.name}</strong>
                      <p className="small muted">
                        <code>{key.prefix}…</code> ·{' '}
                        <time dateTime={new Date(key.createdAt).toISOString()}>
                          {new Date(key.createdAt).toLocaleDateString()}
                        </time>
                      </p>
                    </div>
                    <button
                      className="button"
                      aria-label={`撤销 ${key.name}`}
                      disabled={!!busy}
                      onClick={() => {
                        setFailure('');
                        setFeedback('');
                        setRevoking(key);
                      }}
                    >
                      撤销
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">尚未签发开发机密钥。</p>
            )}
          </section>
        </>
      )}
      {!revoking && <ErrorNote text={failure} />}
      {feedback && (
        <p className="small" role="status">
          {feedback}
        </p>
      )}
      {issuedKey && <IssuedKeyDialog deviceKey={issuedKey} close={() => setIssuedKey('')} />}
      {revoking && (
        <Modal
          title="撤销转发密钥"
          close={() => {
            if (!busy) {
              setRevoking(undefined);
              setFailure('');
            }
          }}
        >
          <p>撤销后，「{revoking.name}」将无法再用这把密钥发起请求。</p>
          <ErrorNote text={failure} />
          <div className="modal-actions">
            <button
              className="button"
              disabled={!!busy}
              onClick={() => {
                setRevoking(undefined);
                setFailure('');
              }}
            >
              取消
            </button>
            <button className="button primary" disabled={!!busy} onClick={() => void revoke()}>
              {busy === 'revoke' ? '撤销中…' : '确认撤销'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
