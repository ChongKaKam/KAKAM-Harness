import { useState, type FormEvent } from 'react';
import { Copy } from 'lucide-react';
import { api, post, remove } from '../../client/api';
import { copyText } from '../../client/clipboard';
import { ErrorNote, Modal, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import './gateway.css';

type GatewayKey = {
  id: string;
  name: string;
  providerId: string;
  providerName: string | null;
  prefix: string;
  createdAt: number;
};

type GatewaySettings = {
  providers: { id: string; name: string }[];
  keys: GatewayKey[];
};

const adminPath = '/admin/openai-gateway';

export function GatewaySettingsPage() {
  const { user } = useWorkspace();
  if (user.role !== 'admin') return <ErrorNote text="需要管理员权限" />;
  return <GatewaySettingsContent key={user.id} />;
}

function GatewaySettingsContent() {
  const { navigate } = useWorkspace();
  const { data, error, reload } = useLoad(() => api<GatewaySettings>(adminPath));
  const [name, setName] = useState('');
  const [issuedKey, setIssuedKey] = useState('');
  const [revoking, setRevoking] = useState<GatewayKey>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [feedback, setFeedback] = useState('');
  const baseUrl = `${location.origin}/api/openai/v1`;

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setFailure('');
    setFeedback('');
    try {
      const result = await post<{ key: string }>(`${adminPath}/keys`, {
        name: name.trim(),
        providerId: form.get('providerId'),
      });
      setIssuedKey(result.key);
      setName('');
      reload();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revoking || busy) return;
    setBusy(true);
    setFailure('');
    try {
      await remove(`${adminPath}/keys/${encodeURIComponent(revoking.id)}`);
      setFeedback(`已撤销「${revoking.name}」`);
      setRevoking(undefined);
      reload();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await copyText(value);
      setFeedback(`${label}已复制`);
    } catch {
      setFeedback('复制失败，请选中文本后手动复制。');
    }
  }

  function closeIssuedKey() {
    setIssuedKey('');
    setFeedback('');
  }

  function closeRevoke() {
    if (busy) return;
    setRevoking(undefined);
    setFailure('');
  }

  return (
    <div className="page openai-gateway">
      <PageHeader
        eyebrow="DEVELOPER API"
        title="OpenAI API 转发"
        description="给每台开发机单独签发密钥。请求经本站转发，OpenAI API Key 保存在服务器上。"
      />
      <div className="panel openai-gateway-panel">
        <label>
          开发机 Base URL
          <input readOnly value={baseUrl} onFocus={(event) => event.currentTarget.select()} />
        </label>
        <button className="button" onClick={() => void copy(baseUrl, 'Base URL')}>
          <Copy size={15} aria-hidden="true" />
          复制地址
        </button>
      </div>
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
            <h2>签发转发密钥</h2>
            {data.providers.length ? (
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
                    disabled={busy}
                  />
                </label>
                <label>
                  OpenAI 来源
                  <select name="providerId" required disabled={busy}>
                    {data.providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="button primary" disabled={busy || !name.trim()}>
                  {busy && !revoking ? '签发中…' : '签发密钥'}
                </button>
              </form>
            ) : (
              <>
                <p className="muted small">
                  先在「模型与接入」添加官方 OpenAI 来源，保存 API Key 并启用要转发的模型。
                </p>
                <button className="button" onClick={() => navigate('settings', 'models')}>
                  前往模型与接入
                </button>
              </>
            )}
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
                        <code>{key.prefix}…</code> · {key.providerName ?? '来源已删除'} ·{' '}
                        <time dateTime={new Date(key.createdAt).toISOString()}>
                          {new Date(key.createdAt).toLocaleDateString()}
                        </time>
                      </p>
                    </div>
                    <button
                      className="button"
                      aria-label={`撤销 ${key.name}`}
                      disabled={busy}
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
      {!issuedKey && feedback && (
        <p className="small" role="status">
          {feedback}
        </p>
      )}
      {issuedKey && (
        <Modal title="保存转发密钥" close={closeIssuedKey}>
          <p className="small muted">
            完整密钥仅显示这一次。使用 Codex 时，可将它保存在开发机的环境变量{' '}
            <code>DRIFT_CODEX_KEY</code>，并将提供商的 <code>env_key</code> 设为该变量名。
          </p>
          <label className="openai-gateway-secret">
            开发机转发密钥
            <textarea
              readOnly
              value={issuedKey}
              rows={2}
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p className="small" role="status">
            {feedback}
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => void copy(issuedKey, '转发密钥')}>
              <Copy size={15} aria-hidden="true" />
              复制密钥
            </button>
            <button className="button primary" onClick={closeIssuedKey}>
              完成
            </button>
          </div>
        </Modal>
      )}
      {revoking && (
        <Modal title="撤销转发密钥" close={closeRevoke}>
          <p>撤销后，使用「{revoking.name}」的开发机将无法再用这把密钥发起请求。</p>
          <ErrorNote text={failure} />
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={closeRevoke}>
              取消
            </button>
            <button className="button primary" disabled={busy} onClick={() => void revoke()}>
              {busy ? '撤销中…' : '确认撤销'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
