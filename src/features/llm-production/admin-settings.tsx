import { useEffect, useRef, useState } from 'react';
import { api, patch } from '../../client/api';
import { ErrorNote, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { productionLimits, type ProductionAdminSettings } from './types';
import { productionBytes } from './presentation';
import './production.css';

export function ProductionAdminSettingsPage() {
  const { user } = useWorkspace();
  if (user.role !== 'admin') return <ErrorNote text="需要管理员权限" />;
  return <ProductionAdminSettingsContent key={user.id} />;
}

function ProductionAdminSettingsContent() {
  const { data, error, reload } = useLoad(() =>
    api<ProductionAdminSettings>('/admin/llm-production/settings'),
  );
  return (
    <div className="page llm-production-settings">
      <PageHeader
        eyebrow="PRODUCTION CAPACITY"
        title="产物容量"
        description="设置每个账户可使用的产物存储上限。"
      />
      <ErrorNote text={error} />
      {!data && !error && <Spinner />}
      {data && <ProductionCapacityForm settings={data} />}
      {error && (
        <button type="button" className="button" onClick={reload}>
          重新加载
        </button>
      )}
    </div>
  );
}

function ProductionCapacityForm({ settings }: { settings: ProductionAdminSettings }) {
  const [capacity, setCapacity] = useState(String(settings.accountLimitMiB));
  const [saved, setSaved] = useState(settings.accountLimitMiB);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const value = Number(capacity);
  const valid =
    capacity.trim() !== '' &&
    Number.isInteger(value) &&
    value >= productionLimits.minAccountMiB &&
    value <= productionLimits.maxAccountMiB;
  const changed = value !== saved;
  return (
    <form
      className="llm-production-settings-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !changed || !valid) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
          const result = await patch<ProductionAdminSettings>('/admin/llm-production/settings', {
            accountLimitMiB: value,
          });
          if (!mounted.current) return;
          setCapacity(String(result.accountLimitMiB));
          setSaved(result.accountLimitMiB);
          setMessage('产物容量已保存，对所有账户立即生效');
        } catch (failure) {
          if (mounted.current) setError((failure as Error).message);
        } finally {
          if (mounted.current) setBusy(false);
        }
      }}
    >
      <section className="llm-production-settings-section">
        <h2>账户存储上限</h2>
        <label>
          每账户产物容量（MiB）
          <input
            type="number"
            required
            min={productionLimits.minAccountMiB}
            max={productionLimits.maxAccountMiB}
            step={1}
            value={capacity}
            disabled={busy}
            aria-describedby="production-capacity-description"
            onChange={(event) => {
              setCapacity(event.target.value);
              setError('');
              setMessage('');
            }}
          />
        </label>
        <p id="production-capacity-description" className="llm-production-settings-description">
          默认 1024 MiB = 1 GiB。此上限适用于每个账户的全部对话和分组产物。
        </p>
        <p className="llm-production-settings-description">
          可设置 {productionLimits.minAccountMiB}–{productionLimits.maxAccountMiB}{' '}
          MiB。单个文件上限仍为 {productionBytes(productionLimits.fileBytes)}。
        </p>
        <p className="llm-production-settings-description">
          调小上限不会删除已有文件。超额账户仍可查看、预览、下载和删除产物；释放足够空间后可继续生成。
        </p>
        {valid && (
          <p className="llm-production-settings-description">
            当前设置：每账户 {productionBytes(value * 1024 * 1024)}
          </p>
        )}
      </section>
      <ErrorNote text={error} />
      <div className="modal-actions llm-production-save-actions">
        <span className="llm-production-save-state" role="status">
          {message || (changed ? '有未保存的设置' : '')}
        </span>
        <button type="submit" className="button primary" disabled={busy || !changed || !valid}>
          {busy ? '保存中…' : '保存容量设置'}
        </button>
      </div>
    </form>
  );
}
