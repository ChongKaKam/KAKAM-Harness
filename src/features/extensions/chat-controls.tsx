import { Globe, Puzzle } from 'lucide-react';
import { ErrorNote, Spinner } from '../../client/components';
import { ExtensionModeControl } from './mode-control';
import type { useExtensions } from './use-extensions';
export { useExtensions } from './use-extensions';
import './extensions.css';

export function ExtensionOptions({
  controls,
  disabled,
}: {
  controls: ReturnType<typeof useExtensions>;
  disabled: boolean;
}) {
  return (
    <div role="group" aria-label="拓展能力">
      <ErrorNote text={controls.error} />
      {controls.loading && <Spinner />}
      {controls.capabilities.map((item) => {
        const Icon = item.icon === 'globe' ? Globe : Puzzle;
        return (
          <section key={item.id} className="extensions-menu-item" aria-label={item.name}>
            <div className="extensions-menu-name">
              <Icon size={18} aria-hidden="true" />
              <strong>{item.name}</strong>
              {(!item.ready || !item.enabled) && (
                <span className="badge">{item.enabled ? '待配置' : '已关闭'}</span>
              )}
            </div>
            <p className="small muted">{item.description}</p>
            <ExtensionModeControl
              name={item.name}
              mode={controls.preferences[item.id] ?? 'off'}
              disabled={disabled || controls.loading || !item.ready || !item.enabled}
              saving={controls.saving}
              change={(mode) => void controls.change(item.id, mode)}
            />
          </section>
        );
      })}
      {!controls.loading && !controls.error && !controls.capabilities.length && (
        <p className="small muted">暂无可用拓展，请在设置中启用插件。</p>
      )}
    </div>
  );
}
