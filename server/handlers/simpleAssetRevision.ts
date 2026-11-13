import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

type ProjectAssets = { fingerprint: string; revision: number };
const assets = new Map<string, ProjectAssets>();

// The host polls project status. Checking metadata on each poll also catches
// editors and filesystems whose recursive fs.watch events are unreliable.
async function fingerprintPublicFiles(publicPath: string): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string, relative = ''): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const name = path.join(relative, entry.name);
      let details;
      try { details = await lstat(child, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      hash.update(JSON.stringify(name));
      hash.update(`:${details.mode}:${details.size}:${details.ino}:${details.mtimeNs}:${details.ctimeNs};`);
      if (entry.isDirectory()) await visit(child, name);
    }
  }
  await visit(publicPath);
  return hash.digest('hex');
}

/** A public asset can change without React source changing. The host tells
 * the running app to refresh only those assets, preserving the iframe state. */
export async function getSimpleAssetRevision(projectPath: string): Promise<number> {
  const key = path.resolve(projectPath);
  const publicPath = path.join(key, 'public');
  await mkdir(publicPath, { recursive: true });
  const fingerprint = await fingerprintPublicFiles(publicPath);
  const previous = assets.get(key);
  if (!previous) {
    assets.set(key, { fingerprint, revision: 0 });
    return 0;
  }
  if (previous.fingerprint !== fingerprint) {
    previous.fingerprint = fingerprint;
    previous.revision += 1;
  }
  return previous.revision;
}

export function stopSimpleAssetWatchersForTest(): void {
  assets.clear();
}
