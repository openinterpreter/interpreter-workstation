import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

function isWithin(rootPath: string, candidatePath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(rootPath + sep);
}

// NOTE(victor): no Node/POSIX API for partial realpath on non-existent paths.
// Walks path segments from longest to shortest, resolving the first existing
// ancestor via realpathSync (which follows symlinks through uv_fs_access,
// see nodejs/node src/node_file.cc:1060). Pattern adapted from
// modelcontextprotocol/servers src/filesystem/lib.ts:115-129.
export function canWritePathInWorkspace(targetPath: string, workspacePath: string): boolean {
  const realWorkspace = realpathSync(workspacePath);
  const segments = resolve(targetPath).split(sep);

  for (let i = segments.length; i > 0; i--) {
    const candidate = segments.slice(0, i).join(sep) || sep;
    try {
      return isWithin(realWorkspace, realpathSync(candidate));
    } catch {}
  }

  return false;
}

