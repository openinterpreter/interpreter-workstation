import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { resolveWikilink } from '../api';
import { resolveWikilinkTarget } from '../extensions/wikilinkTargetResolver';
import { getFileCacheVersion, subscribeFileCache } from '../stores/fileStore';
import { getWorkspacePathSnapshot, subscribeWorkspacePath } from '../stores/workspaceStore';

type CachedWikilinkPathResolution = {
  path: string | null;
  fileCacheVersion: number;
};

const resolvedWikilinkPathCache = new Map<string, CachedWikilinkPathResolution>();
const inflightWikilinkPathResolutions = new Map<string, Promise<string | null>>();

function getWikilinkCacheKey(workspacePath: string | null, target: string): string {
  return `${workspacePath ?? ''}\u0000${target}`;
}

function getWikilinkInflightKey(
  workspacePath: string | null,
  target: string,
  fileCacheVersion: number,
): string {
  return `${getWikilinkCacheKey(workspacePath, target)}\u0000${fileCacheVersion}`;
}

function getCachedResolvedPath(
  cacheKey: string,
  fileCacheVersion: number,
): string | null | undefined {
  const cached = resolvedWikilinkPathCache.get(cacheKey);
  if (!cached || cached.fileCacheVersion !== fileCacheVersion) {
    return undefined;
  }

  return cached.path;
}

async function resolveWikilinkPathFromApi(
  inflightKey: string,
  cacheKey: string,
  target: string,
  fileCacheVersion: number,
): Promise<string | null> {
  const inflight = inflightWikilinkPathResolutions.get(inflightKey);
  if (inflight) {
    return inflight;
  }

  const nextRequest = resolveWikilink(target)
    .then((response) => {
      const resolvedPath = response?.path ?? null;
      resolvedWikilinkPathCache.set(cacheKey, {
        path: resolvedPath,
        fileCacheVersion,
      });
      return resolvedPath;
    })
    .finally(() => {
      inflightWikilinkPathResolutions.delete(inflightKey);
    });

  inflightWikilinkPathResolutions.set(inflightKey, nextRequest);
  return nextRequest;
}

export interface ResolvedWikilinkState {
  path: string;
  label: string;
  found: boolean;
  isPending: boolean;
  resolvePath: () => Promise<string | null | undefined>;
}

export function useResolvedWikilink(target: string): ResolvedWikilinkState {
  const workspacePath = useSyncExternalStore(
    subscribeWorkspacePath,
    getWorkspacePathSnapshot,
    getWorkspacePathSnapshot,
  );
  const fileCacheVersion = useSyncExternalStore(
    subscribeFileCache,
    getFileCacheVersion,
    getFileCacheVersion,
  );
  const syncResolved = resolveWikilinkTarget(target || '', workspacePath);
  const hasTarget = target.trim().length > 0;
  const cacheKey = hasTarget ? getWikilinkCacheKey(workspacePath, target) : '';
  const inflightKey = hasTarget ? getWikilinkInflightKey(workspacePath, target, fileCacheVersion) : '';
  const [asyncResolvedPath, setAsyncResolvedPath] = useState<string | null | undefined>(() => {
    if (!hasTarget || !workspacePath || syncResolved.found) {
      return undefined;
    }

    return getCachedResolvedPath(cacheKey, fileCacheVersion);
  });

  useEffect(() => {
    if (!hasTarget || !workspacePath || syncResolved.found) {
      setAsyncResolvedPath(undefined);
      return;
    }

    setAsyncResolvedPath(getCachedResolvedPath(cacheKey, fileCacheVersion));
  }, [cacheKey, fileCacheVersion, hasTarget, syncResolved.found, workspacePath]);

  const resolvePath = useCallback(async (): Promise<string | null | undefined> => {
    if (!hasTarget) {
      return undefined;
    }

    if (syncResolved.found) {
      return syncResolved.path;
    }

    if (!workspacePath) {
      return undefined;
    }

    const cached = getCachedResolvedPath(cacheKey, fileCacheVersion);
    if (cached !== undefined) {
      setAsyncResolvedPath(cached);
      return cached;
    }

    try {
      const resolvedPath = await resolveWikilinkPathFromApi(
        inflightKey,
        cacheKey,
        target,
        fileCacheVersion,
      );
      setAsyncResolvedPath(resolvedPath);
      return resolvedPath;
    } catch (error) {
      console.error('[wikilink] resolve failed', { target, error });
      setAsyncResolvedPath(null);
      return null;
    }
  }, [cacheKey, fileCacheVersion, hasTarget, inflightKey, syncResolved.found, syncResolved.path, target, workspacePath]);

  const found = syncResolved.found || Boolean(asyncResolvedPath);
  const isPending = !syncResolved.found && workspacePath !== null && asyncResolvedPath === undefined;
  const path = syncResolved.found ? syncResolved.path : (asyncResolvedPath ?? syncResolved.path);

  return {
    path,
    label: syncResolved.label,
    found,
    isPending,
    resolvePath,
  };
}

export function resetResolvedWikilinkCacheForTests(): void {
  resolvedWikilinkPathCache.clear();
  inflightWikilinkPathResolutions.clear();
}
