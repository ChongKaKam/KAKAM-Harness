import { useEffect, useRef, useState } from 'react';
import { Globe, Puzzle } from 'lucide-react';
import { api, patch } from '../../client/api';
import type { ExtensionInfo, ExtensionMode, FeatureManifest } from '../../shared/types';
import './extensions.css';
interface Catalog {
  capabilities: ExtensionInfo[];
  modes: Record<string, ExtensionMode>;
}
const names = { auto: '自动', on: '开启', off: '关闭' };
const next = { off: 'on', on: 'auto', auto: 'off' } as const;
export function useExtensions(userId: string, features: FeatureManifest[]) {
  const [state, setState] = useState<{ userId: string; data: Catalog }>();
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);
  const version = useRef(0);
  const revision = features.map((f) => `${f.id}:${f.enabled}`).join(',');
  useEffect(() => {
    let current = true;
    setError('');
    const reload = () => {
      if (editing.current) return;
      const requested = version.current;
      api<Catalog>('/extensions')
        .then((data) => {
          if (current && requested === version.current) {
            setState({ userId, data });
            setError('');
          }
        })
        .catch((error) => {
          if (current && requested === version.current) setError(error.message);
        });
    };
    reload();
    const timer = setInterval(reload, 30_000);
    window.addEventListener('focus', reload);
    window.addEventListener('online', reload);
    return () => {
      current = false;
      clearInterval(timer);
      window.removeEventListener('focus', reload);
      window.removeEventListener('online', reload);
    };
  }, [userId, revision]);
  const data = state?.userId === userId ? state.data : undefined;
  const capabilities = data?.capabilities ?? [];
  const modes = Object.fromEntries(
    capabilities
      .filter((item) => item.ready && item.enabled)
      .map((item) => [item.id, data?.modes[item.id] ?? 'off']),
  );
  async function change(id: string, mode: ExtensionMode) {
    if (!data || editing.current) return;
    editing.current = true;
    version.current++;
    setSaving(true);
    setError('');
    const updated = { ...data.modes, [id]: mode };
    try {
      await patch('/extensions/preferences', { modes: updated });
      setState({ userId, data: { ...data, modes: updated } });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      editing.current = false;
      setSaving(false);
    }
  }
  return { capabilities, modes, change, saving, error, loading: !data && !error };
}
export function ExtensionControls({
  controls,
  disabled,
}: {
  controls: ReturnType<typeof useExtensions>;
  disabled: boolean;
}) {
  return (
    <div className="extensions-controls" role="group" aria-label="拓展能力">
      {controls.capabilities.map((item) => {
        const mode = controls.modes[item.id] ?? 'off';
        const Icon = item.icon === 'globe' ? Globe : Puzzle;
        const ready = item.ready && item.enabled;
        return (
          <button
            key={item.id}
            type="button"
            className={`extensions-toggle ${mode !== 'off' ? 'active' : ''}`}
            disabled={disabled || controls.saving || !ready}
            aria-label={`${item.name}：${names[mode]}`}
            aria-pressed={mode === 'auto' ? 'mixed' : mode === 'on'}
            title={
              ready
                ? `${item.name} · ${names[mode]}，点击切换为${names[next[mode]]}`
                : `${item.name} 尚未配置或已关闭，请联系管理员`
            }
            onClick={() => void controls.change(item.id, next[mode])}
          >
            <Icon size={17} aria-hidden="true" />
            <span>{names[mode]}</span>
          </button>
        );
      })}
    </div>
  );
}
