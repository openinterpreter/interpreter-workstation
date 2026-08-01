import type { RunnableProjectMetadata } from './projectRunner';

export interface FolderTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  mtime?: number;
  runnableProject?: RunnableProjectMetadata;
  children?: FolderTreeNode[];
}
