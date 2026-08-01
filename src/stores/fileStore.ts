/**
 * File Store
 *
 * Shared cache of workspace files. Populated by Explorer, read by mentions.
 * Updates when file watcher detects changes.
 */

export interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

type Listener = () => void;

// Global file cache
let cachedFiles: FileEntry[] = [];
let lastUpdateTime = 0;
let cacheVersion = 0;
let listeners = new Set<Listener>();

function emitChange(): void {
  cacheVersion += 1;

  for (const listener of listeners) {
    listener();
  }
}

/**
 * Set the file cache (called by Explorer when it loads files)
 */
export function setFileCache(files: FileEntry[]) {
  cachedFiles = files;
  lastUpdateTime = Date.now();
  emitChange();
}

/**
 * Get the cached files (instant, no API call)
 */
export function getFileCache(): FileEntry[] {
  return cachedFiles;
}

export function getFileCacheVersion(): number {
  return cacheVersion;
}

/**
 * Check if cache has been populated
 */
export function hasFileCache(): boolean {
  return cachedFiles.length > 0;
}

/**
 * Get cache age in ms
 */
export function getFileCacheAge(): number {
  return Date.now() - lastUpdateTime;
}

/**
 * Clear the cache (call when workspace changes)
 */
export function clearFileCache() {
  cachedFiles = [];
  lastUpdateTime = 0;
  emitChange();
}

export function subscribeFileCache(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function resetFileStoreForTests(): void {
  cachedFiles = [];
  lastUpdateTime = 0;
  cacheVersion = 0;
  listeners = new Set<Listener>();
}
