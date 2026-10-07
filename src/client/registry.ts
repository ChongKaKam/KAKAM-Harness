import type { ComponentType } from 'react';
import {
  MessageSquare,
  ChartNoAxesCombined,
  Users,
  Layers,
  BookOpen,
  Settings,
  GitBranch,
  Brain,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ExtensionsPage } from '../features/extensions/client';
import { SearchPage } from '../features/search/client';
import { manifest as extensions } from '../features/extensions/manifest';
import { manifest as search } from '../features/search/manifest';
import { ChatPage } from '../features/chat/client';
import { UsagePage } from '../features/usage/client';
import { UsersPage } from '../features/users/client';
import { ModelsPage } from '../features/models/client';
import { PromptsPage } from '../features/prompts/client';
import { PromptsSettings } from '../features/prompts/settings';
import { ContextManagerSettings } from '../features/context-manager/client';
import { MemoryPage, MemorySettingsPage } from '../features/memory/client';
import { manifest as memory } from '../features/memory/manifest';
import { manifest as contextManager } from '../features/context-manager/manifest';
import { PreferencesPage } from '../features/preferences/client';
import { manifest as preferences } from '../features/preferences/manifest';
import { AccountPage } from '../features/auth/client';
import { manifest as chat } from '../features/chat/manifest';
import { manifest as usage } from '../features/usage/manifest';
import { manifest as users } from '../features/users/manifest';
import { manifest as models } from '../features/models/manifest';
import { manifest as prompts } from '../features/prompts/manifest';
import { manifest as auth } from '../features/auth/manifest';
import type { FeatureManifest } from '../shared/types';
export interface ClientFeature {
  manifest: FeatureManifest;
  icon: LucideIcon;
  component: ComponentType;
  placement: 'workspace' | 'statistics' | 'settings';
  settingsLabel?: string;
  settingsParent?: string;
  /** Optional settings page for a feature that also has a workspace page. */
  settingsComponent?: ComponentType;
}
// Build-time client catalog; runtime availability comes from the authenticated server registry.
export const clientFeatures: ClientFeature[] = [
  { placement: 'settings', manifest: extensions, icon: Layers, component: ExtensionsPage },
  {
    placement: 'settings',
    manifest: search,
    icon: Layers,
    component: SearchPage,
    settingsParent: 'extensions',
  },
  { placement: 'workspace', manifest: chat, icon: MessageSquare, component: ChatPage },
  {
    placement: 'settings',
    settingsLabel: '上下文管理',
    manifest: contextManager,
    icon: GitBranch,
    component: ContextManagerSettings,
  },
  {
    placement: 'workspace',
    manifest: prompts,
    icon: BookOpen,
    component: PromptsPage,
    settingsComponent: PromptsSettings,
  },
  {
    placement: 'workspace',
    manifest: memory,
    icon: Brain,
    component: MemoryPage,
    settingsLabel: '记忆管理',
    settingsComponent: MemorySettingsPage,
  },
  { placement: 'statistics', manifest: usage, icon: ChartNoAxesCombined, component: UsagePage },
  { placement: 'settings', manifest: models, icon: Layers, component: ModelsPage },
  { placement: 'settings', manifest: users, icon: Users, component: UsersPage },
  {
    placement: 'settings',
    settingsLabel: '通用设置',
    manifest: preferences,
    icon: Settings,
    component: PreferencesPage,
  },
  {
    placement: 'settings',
    settingsLabel: '账户设置',
    manifest: auth,
    icon: Settings,
    component: AccountPage,
  },
];
