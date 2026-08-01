import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.interpreter');
const CACHE_FILE = join(CONFIG_DIR, 'file-tree-cache.json');

interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  mtime?: number;
  thumbnailWidth?: number;
  thumbnailHeight?: number;
  fileIcon?: string;
  runnableProject?: import('../shared/types/projectRunner').RunnableProjectMetadata;
  children?: FileTreeNode[];
}

interface CachedFileTree {
  workspacePath: string;
  files: FileTreeNode[];
  timestamp: number;
}

export function writeFileTreeCache(workspacePath: string, files: FileTreeNode[]): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const data: CachedFileTree = { workspacePath, files, timestamp: Date.now() };
    writeFileSync(CACHE_FILE, JSON.stringify(data));
    console.log('[FileTreeCache] Saved cache for:', workspacePath);
  } catch (error) {
    console.error('[FileTreeCache] Failed to write cache:', error);
  }
}

export function getFileTreeCachePath(): string {
  return CACHE_FILE;
}
