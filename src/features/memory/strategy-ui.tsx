import type { ComponentType } from 'react';
import type { MemoryStrategyInfo } from '../../shared/memory';
import { DefaultMemorySettings } from './strategies/default-settings';

export interface MemoryStrategySettingsProps {
  config: Record<string, unknown>;
  defaults: Record<string, unknown>;
  disabled: boolean;
  onChange(config: Record<string, unknown>): void;
}
export interface MemoryStrategyClient {
  id: string;
  settingsKey: string;
  configVersion: number;
  Settings: ComponentType<MemoryStrategySettingsProps>;
}
/** Every selectable server strategy must have a paired, build-time settings component. */
export const memoryStrategyClients: MemoryStrategyClient[] = [
  { id: 'default', settingsKey: 'default', configVersion: 1, Settings: DefaultMemorySettings },
];
export function memoryStrategyClient(strategy: MemoryStrategyInfo) {
  return memoryStrategyClients.find(
    (entry) =>
      entry.id === strategy.id &&
      entry.settingsKey === strategy.settingsKey &&
      entry.configVersion === strategy.configVersion,
  );
}
