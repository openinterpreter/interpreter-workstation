import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getInterpreterOverlayNativeHelperPath } from '../runtime/infra/native-helper-paths';
import type { Bounds } from '../shared/types';

const execFileAsync = promisify(execFile);

export interface SelectedFileSource {
  path: string;
  bounds: Bounds | null;
}

export function isRawBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const bounds = value as Partial<Bounds>;
  return typeof bounds.x === 'number'
    && typeof bounds.y === 'number'
    && typeof bounds.width === 'number'
    && typeof bounds.height === 'number';
}

export async function readSelectedFinderFiles(): Promise<SelectedFileSource[]> {
  const helperPath = getInterpreterOverlayNativeHelperPath('selected-file-context');
  const { stdout } = await execFileAsync(helperPath, [], {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  const rawFiles = JSON.parse(stdout) as unknown;
  if (!Array.isArray(rawFiles)) {
    throw new Error('selected-file-context returned a non-array payload.');
  }
  return rawFiles.map((item): SelectedFileSource => {
    if (!item || typeof item !== 'object') {
      throw new Error('selected-file-context returned a malformed selected file.');
    }
    const rawFile = item as { path?: unknown; bounds?: unknown };
    if (typeof rawFile.path !== 'string' || rawFile.path.length === 0) {
      throw new Error('selected-file-context returned a selected file without a path.');
    }
    return {
      path: rawFile.path,
      bounds: isRawBounds(rawFile.bounds) ? rawFile.bounds : null,
    };
  });
}
