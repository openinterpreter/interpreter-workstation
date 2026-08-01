import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  RunnableProjectMetadata,
  RunnableProjectRunScript,
} from '../../shared/types/projectRunner';

const runnableProjectDetectionCache = new Map<string, Promise<RunnableProjectMetadata | undefined>>();

function resolveRunnableProjectRunScript(
  scripts: Record<string, unknown> | undefined,
): RunnableProjectRunScript | null {
  if (typeof scripts?.dev === 'string') {
    return 'dev';
  }

  if (typeof scripts?.start === 'string') {
    return 'start';
  }

  return null;
}

export function invalidateRunnableProjectDetection(filePath: string | null | undefined): void {
  if (!filePath || path.basename(filePath) !== 'package.json') {
    return;
  }

  runnableProjectDetectionCache.delete(filePath);
}

export async function detectRunnableProject(dirPath: string): Promise<RunnableProjectMetadata | undefined> {
  const packageJsonPath = path.join(dirPath, 'package.json');
  const cached = runnableProjectDetectionCache.get(packageJsonPath);
  if (cached) {
    return cached;
  }

  const pendingResult = (async (): Promise<RunnableProjectMetadata | undefined> => {
    try {
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as {
        scripts?: Record<string, unknown>;
      };
      const runScript = resolveRunnableProjectRunScript(packageJson.scripts);

      if (!runScript) {
        return undefined;
      }

      return {
        kind: 'node-web-app',
        runScript,
      };
    } catch {
      return undefined;
    }
  })();

  runnableProjectDetectionCache.set(packageJsonPath, pendingResult);
  try {
    return await pendingResult;
  } catch (error) {
    runnableProjectDetectionCache.delete(packageJsonPath);
    throw error;
  }
}
