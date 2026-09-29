import { SegmentedControl } from '../../client/segmented-control';
import type { ExtensionMode } from '../../shared/types';
const options = [
  { value: 'auto', label: 'Auto', description: '自动判断' },
  { value: 'on', label: 'On', description: '始终开启' },
  { value: 'off', label: 'Off', description: '始终关闭' },
] as const;
export function ExtensionModeControl({
  name,
  mode,
  disabled,
  saving = false,
  change,
}: {
  name: string;
  mode: ExtensionMode;
  disabled: boolean;
  saving?: boolean;
  change: (mode: ExtensionMode) => void;
}) {
  return (
    <SegmentedControl
      className="extensions-modes"
      label={`${name} 默认模式`}
      options={options}
      value={mode}
      disabled={disabled}
      busy={saving}
      onChange={change}
    />
  );
}
