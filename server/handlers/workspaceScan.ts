import { existsSync } from 'node:fs';
import { basemindScan, basemindRescan, resolveBasemindBinary, isDaemonRunning } from '../utils/basemindManager';
import { resolveXbergPipelineBinary } from '../utils/xbergPipelineBinary';
import path from 'node:path';

export interface WorkspaceScanRequest {
  /** Absolute workspace root path (basemind --root). */
  workspacePath: string;
  /** Paths to scan relative to workspace root. Defaults to ['.redacted']. */
  paths?: string[];
  /** Use --json for machine-readable output. */
  json?: boolean;
}

export interface WorkspaceScanResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface WorkspaceScanStatus {
  redactionActive: boolean;
  indexing: boolean;
  fileCount: number;
  lastScanAt: string | null;
  xbergAvailable: boolean;
  basemindAvailable: boolean;
  resourcesReady: {
    nerModel: boolean;
    embeddings: boolean;
    reranker: boolean;
  };
}

let activeScanCount = 0;
let filesRemaining = 0;
let lastScanAt: string | null = null;

export function setIndexingState(inProgress: boolean, count: number = 0) {
  if (inProgress) {
    activeScanCount++;
  } else {
    activeScanCount = Math.max(0, activeScanCount - 1);
  }
  filesRemaining = count;
  if (activeScanCount === 0 && count === 0) {
    lastScanAt = new Date().toISOString();
  }
}

const GLOBAL_RESOURCES_DIR = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.local', 'share', 'basemind');

function resourceReady(resource: 'nerModel' | 'embeddings' | 'reranker'): boolean {
  const markers: Record<typeof resource, string> = {
    nerModel: 'ner-model.ready',
    embeddings: 'embeddings.ready',
    reranker: 'reranker.ready',
  };
  return existsSync(path.join(GLOBAL_RESOURCES_DIR, markers[resource]));
}

/**
 * Returns the current status of workspace scanning, xberg pipeline availability,
 * and global resource readiness.
 */
export function getWorkspaceScanStatus(): WorkspaceScanStatus {
  let xbergAvailable = false;
  try {
    resolveXbergPipelineBinary();
    xbergAvailable = true;
  } catch {
    xbergAvailable = false;
  }

  const basemindAvailable = isDaemonRunning();

  return {
    redactionActive: xbergAvailable,
    indexing: activeScanCount > 0,
    fileCount: filesRemaining,
    lastScanAt,
    xbergAvailable,
    basemindAvailable,
    resourcesReady: {
      nerModel: basemindAvailable,
      embeddings: basemindAvailable,
      reranker: basemindAvailable,
    },
  };
}

/**
 * Scan the .redacted/ shadow file corpus with basemind.
 * Call this after workspacePseudonymize writes shadow files.
 */
export async function workspaceScan(req: WorkspaceScanRequest): Promise<WorkspaceScanResult> {
  const { workspacePath, paths = ['.redacted'], json = true } = req;

  setIndexingState(true, 1);
  const result = await basemindScan({
    root: workspacePath,
    paths,
    json,
  });
  setIndexingState(false, 0);

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

/**
 * Re-scan specific paths (faster than full scan for incremental updates).
 */
export async function workspaceRescan(req: WorkspaceScanRequest): Promise<WorkspaceScanResult> {
  const { workspacePath, paths = ['.redacted'], json = true } = req;

  setIndexingState(true, paths.length);
  const result = await basemindRescan({
    root: workspacePath,
    paths,
    json,
  });
  setIndexingState(false, 0);

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}
