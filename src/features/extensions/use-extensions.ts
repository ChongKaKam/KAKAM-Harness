import { useEffect, useRef, useState } from 'react';
import { api, patch } from '../../client/api';
import type { ExtensionInfo, ExtensionMode, FeatureManifest } from '../../shared/types';
interface Catalog {
  capabilities: ExtensionInfo[];
  modes: Record<string, ExtensionMode>;
}
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
    window.addEventListener('drift:extensions-changed', reload);
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('drift:extensions');
    if (channel)
      channel.onmessage = (event) => {
        if (event.data === userId) reload();
      };
    return () => {
      current = false;
      clearInterval(timer);
      window.removeEventListener('focus', reload);
      window.removeEventListener('online', reload);
      window.removeEventListener('drift:extensions-changed', reload);
      channel?.close();
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
    try {
      const { modes } = await patch<{ modes: Record<string, ExtensionMode> }>(
        '/extensions/preferences',
        { id, mode },
      );
      setState({ userId, data: { ...data, modes } });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      editing.current = false;
      setSaving(false);
      window.dispatchEvent(new Event('drift:extensions-changed'));
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('drift:extensions');
        channel.postMessage(userId);
        channel.close();
      }
    }
  }
  return {
    capabilities,
    modes,
    preferences: data?.modes ?? {},
    change,
    saving,
    error,
    loading: !data && !error,
  };
}
