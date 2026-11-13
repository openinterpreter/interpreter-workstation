import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSimpleProjectChildPath, getActiveSimpleProject } from '../simpleProjects';

const ASSET = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.(png|jpe?g|webp|gif|avif)$/i;

function assetPathSegments(name: string): string[] {
  const segments = name.split('/');
  if (
    segments.length === 0
    || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))
    || !ASSET.test(segments[segments.length - 1] ?? '')
  ) {
    throw new Error('Invalid asset name');
  }
  return segments;
}

async function assetDirectory(): Promise<{ projectPath: string; directory: string }> {
  const project = await getActiveSimpleProject();
  const projectPath = project.path;
  const directory = assertSimpleProjectChildPath(projectPath, join(projectPath, project.legacy ? 'assets' : 'public'));
  await mkdir(directory, { recursive: true });
  return { projectPath, directory };
}

async function checkedAsset(projectPath: string, path: string): Promise<string> {
  assertSimpleProjectChildPath(projectPath, path);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Symlink interface assets are not allowed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return path;
}

export async function readSimpleInterfaceAsset(name: string): Promise<{ bytes: Buffer; mime: string }> {
  const segments = assetPathSegments(name);
  const { projectPath, directory } = await assetDirectory();
  const path = await checkedAsset(projectPath, join(directory, ...segments));
  const ext = name.split('.').pop()!.toLowerCase();
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await file.stat()).size > 10 * 1024 * 1024) throw new Error('Image exceeds size limit');
    return { bytes: await file.readFile(), mime: mime[ext] };
  } finally { await file.close(); }
}
