import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PublicThreadSnapshot } from '../../shared/types/publicThread';

export type CachedPublicThreadSnapshot = {
  snapshot: PublicThreadSnapshot;
  refreshedAt: number;
};

function isPublicThreadSnapshot(value: unknown, threadId: string): value is PublicThreadSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<PublicThreadSnapshot>;
  return snapshot.schemaVersion === 1
    && snapshot.threadId === threadId
    && typeof snapshot.title === 'string'
    && typeof snapshot.status === 'string'
    && Array.isArray(snapshot.messages)
    && typeof snapshot.updatedAt === 'number'
    && !!snapshot.page
    && typeof snapshot.page === 'object';
}

export async function readPublicThreadCache(
  cachePath: string | undefined,
  threadId: string,
): Promise<CachedPublicThreadSnapshot | null> {
  if (!cachePath) return null;
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<CachedPublicThreadSnapshot>;
    if (typeof parsed.refreshedAt !== 'number' || !isPublicThreadSnapshot(parsed.snapshot, threadId)) {
      return null;
    }
    return { snapshot: parsed.snapshot, refreshedAt: parsed.refreshedAt };
  } catch {
    return null;
  }
}

export async function writePublicThreadCache(
  cachePath: string | undefined,
  state: CachedPublicThreadSnapshot,
): Promise<void> {
  if (!cachePath) return;
  await mkdir(dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, cachePath);
}
