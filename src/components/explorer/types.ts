import type { NodeApi, TreeApi } from '../../lib/react-arborist';
import type { RunnableProjectMetadata } from '../../../shared/types/projectRunner';

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  mtime?: number;
  thumbnail?: string;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  fileIcon?: string;
  runnableProject?: RunnableProjectMetadata;
  children?: FileTreeNode[];
  isResolved?: boolean;
}

export type FileNodeApi = NodeApi<FileTreeNode>;
export type FileTreeApi = TreeApi<FileTreeNode>;
