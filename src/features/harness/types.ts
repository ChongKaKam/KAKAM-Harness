export type WorkspaceKind = 'instructions' | 'memory' | 'document' | 'handoff' | 'artifact';
export interface WorkspaceDocument {
  id: string;
  name: string;
  kind: WorkspaceKind;
  scope: 'private' | 'project' | 'granted';
  version: number;
  sourceConversationId: string | null;
}
export interface WorkspaceRevision extends WorkspaceDocument {
  content: string;
}
export interface WorkspaceApproval {
  id: string;
  groupId: string;
  sourceConversationId: string;
  targetConversationId: string;
  taskId: string;
  purpose: string;
  documentId: string | null;
  version: number | null;
  name: string | null;
  status: 'pending' | 'preauthorized' | 'approved' | 'rejected';
  expiresAt: string | null;
}
export interface WorkspacePreference {
  id: string;
  content: string;
  version: number;
  status: 'pending' | 'active' | 'withdrawn';
  admittedAt: string | null;
}
export interface WorkspaceView {
  groupId: string | null;
  documents: WorkspaceDocument[];
  approvals: WorkspaceApproval[];
  preferences: WorkspacePreference[];
  sources: { id: string; title: string }[];
}
