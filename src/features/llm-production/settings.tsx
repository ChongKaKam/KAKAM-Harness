import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { api, patch } from '../../client/api';
import { ErrorNote, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import type { Model } from '../../shared/types';
import type { ProductionPreferences, ProductionSettings } from './types';
import { productionBytes } from './presentation';
import './production.css';

export function ProductionSettingsPage() {
  const { user } = useWorkspace();
  return <ProductionSettingsContent key={user.id} />;
}

function ProductionSettingsContent() {
  const { navigate } = useWorkspace();
  const { data, error, reload } = useLoad(async () => {
    const [settings, models] = await Promise.all([
      api<ProductionSettings>('/llm-production/settings'),
      api<Model[]>('/models?kind=image'),
    ]);
    return { settings, models };
  });
  return (
    <div className="page llm-production-settings">
      <PageHeader
        eyebrow="PRODUCTION SETTINGS"
        title="产物设置"
        description="配置聊天生成、临时产物保留天数与图片模型。"
        action={
          <button type="button" className="button" onClick={() => navigate('llm-production')}>
            <FolderOpen size={16} aria-hidden="true" />
            管理产物
          </button>
        }
      />
      <ErrorNote text={error} />
      {!data && !error && <Spinner />}
      {data && (
        <ProductionPreferencesForm
          settings={data.settings}
          models={data.models}
          refreshed={reload}
        />
      )}
      {error && (
        <button type="button" className="button" onClick={reload}>
          重新加载
        </button>
      )}
    </div>
  );
}

function ProductionPreferencesForm({
  settings,
  models,
  refreshed,
}: {
  settings: ProductionSettings;
  models: Model[];
  refreshed: () => void;
}) {
  const [preferences, setPreferences] = useState(settings.preferences);
  const [saved, setSaved] = useState(settings.preferences);
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
  const available = models.filter((model) => model.kind === 'image' && model.enabled);
  const missing =
    !!preferences.imageModelId && !available.some((model) => model.id === preferences.imageModelId);
  const changed = JSON.stringify(preferences) !== JSON.stringify(saved);
  const usedPercent = Math.min(
    100,
    (settings.storage.usedBytes / settings.storage.limitBytes) * 100,
  );
  function update<Key extends keyof ProductionPreferences>(
    key: Key,
    value: ProductionPreferences[Key],
  ) {
    setPreferences((current) => ({ ...current, [key]: value }));
    setMessage('');
    setError('');
  }
  return (
    <form
      className="llm-production-settings-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !changed || missing) return;
        setBusy(true);
        setError('');
        setMessage('');
        try {
          const result = await patch<ProductionPreferences>(
            '/llm-production/preferences',
            preferences,
          );
          if (!mounted.current) return;
          setPreferences(result);
          setSaved(result);
          setMessage('产物设置已保存');
          refreshed();
        } catch (failure) {
          if (mounted.current) {
            setError((failure as Error).message);
            refreshed();
          }
        } finally {
          if (mounted.current) setBusy(false);
        }
      }}
    >
      <section className="llm-production-settings-section">
        <h2>聊天生成</h2>
        <label className="llm-production-check">
          <input
            type="checkbox"
            checked={preferences.enabled}
            disabled={busy}
            onChange={(event) => update('enabled', event.target.checked)}
          />
          <span>允许模型在聊天中生成文件与图片</span>
        </label>
        <p className="llm-production-settings-description">
          选择已启用工具调用的聊天模型，发送消息时说明需要交付的内容与格式。关闭后仍可查看和下载已有产物。
        </p>
        <p className="llm-production-settings-description">
          输入栏「产物输出」默认自动，由聊天模型判断是否需要生成；选择「必须产物」后，先建立交付清单，再逐项生成文件或图片，需求不足时先澄清。选择仅保留在当前页面的聊天草稿中，不作为账户默认设置。
        </p>
        <p className="llm-production-settings-description">
          单个产物可直接生成，多项交付可先建立清单并逐项显示进度。文字说明、代码块和下载链接不能替代真实文件，部分失败时保留已生成的产物。
        </p>
        <p className="llm-production-settings-description">
          支持文本、Markdown、JSON、CSV、HTML、SVG、PDF、Word、Excel 和
          PowerPoint；图片生成需另行选择图片模型。
        </p>
      </section>
      <section className="llm-production-settings-section">
        <h2>空间与保留时间</h2>
        <label>
          临时产物保留天数
          <select
            aria-label="临时产物保留天数"
            value={preferences.temporaryRetentionDays}
            disabled={busy}
            onChange={(event) => update('temporaryRetentionDays', Number(event.target.value))}
          >
            {[3, 4, 5, 6, 7].map((days) => (
              <option key={days} value={days}>
                {days} 天
              </option>
            ))}
          </select>
        </label>
        <p className="llm-production-settings-description">
          未分组聊天各自拥有临时空间，产物到期后自动清理；同一分组内的聊天共享产物空间，默认不过期。
        </p>
        <p className="llm-production-settings-description">
          修改天数会重新计算已有临时产物的到期时间，缩短后已到期的文件可能立即清理。
        </p>
        <p className="llm-production-settings-description">
          对话移入分组时，临时产物一同转入；已有分组产物在来源对话移出或删除后仍保留在原分组。删除分组后，未归入其他分组的产物开始按临时保留时间计算。
        </p>
      </section>
      <section className="llm-production-settings-section">
        <h2>图片生成</h2>
        <label>
          图片模型
          <select
            aria-label="图片模型"
            value={preferences.imageModelId ?? ''}
            disabled={busy}
            onChange={(event) => update('imageModelId', event.target.value || null)}
          >
            <option value="">不启用图片生成</option>
            {missing && (
              <option value={preferences.imageModelId!} disabled>
                原图片模型已停用或未授权，请重新选择
              </option>
            )}
            {available.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} · {model.providerName}
              </option>
            ))}
          </select>
        </label>
        <p className="llm-production-settings-description">
          仅显示当前账户可用的图片模型。生成图片时才会调用所选模型，实际用量计入统计。
        </p>
        <p className="llm-production-settings-description">
          图片调用失败不会自动重试；重新输出会发起新的生成请求，可能再次产生用量。
        </p>
        {!available.length && (
          <p className="notice">暂无可用的图片模型，请由管理员添加图片模型并授权。</p>
        )}
      </section>
      <section className="llm-production-settings-section">
        <h2>存储空间</h2>
        <div className="llm-production-storage-label">
          <span>已用 {productionBytes(settings.storage.usedBytes)}</span>
          <span>上限 {productionBytes(settings.storage.limitBytes)}</span>
        </div>
        <progress
          className="llm-production-storage-meter"
          value={usedPercent}
          max={100}
          aria-label="产物存储使用比例"
        />
        <p className="llm-production-settings-description">
          单个文件最大 {productionBytes(settings.storage.maxFileBytes)}
          。达到账户上限时，请在产物空间删除不再需要的文件。
        </p>
      </section>
      <ErrorNote text={error} />
      <div className="modal-actions llm-production-save-actions">
        <span className="llm-production-save-state" role="status">
          {message || (changed ? '有未保存的设置' : '')}
        </span>
        <button type="submit" className="button primary" disabled={busy || !changed || missing}>
          {busy ? '保存中…' : '保存设置'}
        </button>
      </div>
    </form>
  );
}
