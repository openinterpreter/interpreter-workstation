export interface OpenTargetStats {
  isDirectory: boolean;
}

interface ResolveOpenTargetOptions {
  canOpenFolderTabs?: boolean;
  getStats?: (path: string) => Promise<OpenTargetStats>;
}

function defaultCanOpenFolderTabs(): boolean {
  return typeof window !== 'undefined'
    && Boolean(window.electron?.files?.listDirectory);
}

function defaultGetStats(): ((path: string) => Promise<OpenTargetStats>) | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.electron?.files?.getStats;
}

export async function resolveOpenTargetType(
  path: string,
  options: ResolveOpenTargetOptions = {},
): Promise<'file' | 'folder'> {
  const canOpenFolderTabs = options.canOpenFolderTabs ?? defaultCanOpenFolderTabs();
  if (!canOpenFolderTabs) {
    return 'file';
  }

  const getStats = options.getStats ?? defaultGetStats();
  if (!getStats) {
    return 'file';
  }

  try {
    const stats = await getStats(path);
    return stats.isDirectory ? 'folder' : 'file';
  } catch {
    return 'file';
  }
}
