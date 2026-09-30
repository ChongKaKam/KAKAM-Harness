import type { SelectedSkill } from '../features/skills/types';
import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';
import type { Conversation, FeatureManifest, Model, User } from '../shared/types';
export interface WorkspaceContext {
  user: User;
  setUser: (user: User) => void;
  models: Model[];
  conversations: Conversation[];
  features: FeatureManifest[];
  refresh: () => Promise<void>;
  navigate: (page: string, conversationId?: string) => void;
  notify: (text: string) => void;
  conversationId?: string;
  draftSkills: SelectedSkill[];
  setDraftSkills: Dispatch<SetStateAction<SelectedSkill[]>>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
}
export const Workspace = createContext<WorkspaceContext>(null!);
export const useWorkspace = () => useContext(Workspace);
