export type PublicWorkspaceCapability = 'browse' | 'read';

export type PublicWorkspaceEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt: number;
};

export type PublicWorkspaceListing = {
  schemaVersion: 1;
  name: string;
  path: string;
  capabilities: PublicWorkspaceCapability[];
  entries: PublicWorkspaceEntry[];
};
