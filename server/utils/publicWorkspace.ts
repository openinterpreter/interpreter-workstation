import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  PublicWorkspaceEntry,
  PublicWorkspaceListing,
} from '../../shared/types/publicWorkspace';

const MAX_DIRECTORY_ENTRIES = 1_000;
export const MAX_PUBLIC_FILE_BYTES = 250 * 1024 * 1024;

function toPublicPath(value: string): string {
  return value.split(path.sep).join('/');
}

export function validatePublicWorkspacePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.includes('\0') || path.isAbsolute(value)) {
    throw new Error('Invalid workspace path.');
  }

  const normalized = path.posix.normalize(value.split('\\').join('/'));
  if (normalized === '.' || normalized === '/') return '';
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Invalid workspace path.');
  }
  return normalized.replace(/^\.\//, '').replace(/\/$/, '');
}

async function canonicalRoot(root: string): Promise<string> {
  const resolved = await realpath(root);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error('Public workspace root is not a directory.');
  return resolved;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function resolvePublicWorkspaceEntry(
  root: string,
  requestedPath: unknown,
): Promise<{ root: string; absolutePath: string; relativePath: string }> {
  const resolvedRoot = await canonicalRoot(root);
  const relativePath = validatePublicWorkspacePath(requestedPath);
  const candidate = path.resolve(resolvedRoot, ...relativePath.split('/').filter(Boolean));
  if (!isWithinRoot(resolvedRoot, candidate)) throw new Error('Invalid workspace path.');

  const resolvedCandidate = await realpath(candidate);
  if (!isWithinRoot(resolvedRoot, resolvedCandidate)) throw new Error('Workspace symlinks cannot leave the public root.');

  return { root: resolvedRoot, absolutePath: resolvedCandidate, relativePath };
}

export async function listPublicWorkspace(
  root: string,
  requestedPath: unknown,
  name = 'Workspace',
): Promise<PublicWorkspaceListing> {
  const resolved = await resolvePublicWorkspaceEntry(root, requestedPath);
  const directoryMetadata = await stat(resolved.absolutePath);
  if (!directoryMetadata.isDirectory()) throw new Error('Workspace path is not a directory.');

  const children = await readdir(resolved.absolutePath, { withFileTypes: true });
  const entries = await Promise.all(children.slice(0, MAX_DIRECTORY_ENTRIES).map(async (child) => {
    if (child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) return null;
    const childPath = path.join(resolved.absolutePath, child.name);
    const metadata = await stat(childPath);
    const relativePath = toPublicPath(path.relative(resolved.root, childPath));
    return {
      name: child.name,
      path: relativePath,
      type: child.isDirectory() ? 'directory' : 'file',
      ...(child.isFile() ? { size: metadata.size } : {}),
      modifiedAt: metadata.mtimeMs,
    } satisfies PublicWorkspaceEntry;
  }));

  return {
    schemaVersion: 1,
    name,
    path: resolved.relativePath,
    capabilities: ['browse', 'read'],
    entries: entries
      .filter((entry): entry is PublicWorkspaceEntry => entry !== null)
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
      }),
  };
}

const PUBLIC_MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
};

export function publicWorkspaceMimeType(filePath: string): string {
  return PUBLIC_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
