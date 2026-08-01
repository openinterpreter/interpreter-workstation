import { existsSync } from 'node:fs';
import path from 'node:path';

export function uniquePaths(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    result.push(candidate);
  }
  return result;
}

function isInsideAppAsar(candidatePath: string): boolean {
  return path.normalize(candidatePath).split(path.sep).includes('app.asar');
}

export function resolveSourceAppRootCandidates(): string[] {
  const moduleDirs = uniquePaths([
    typeof __dirname === 'string' ? __dirname : null,
    process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null,
  ]).filter((dir) => !isInsideAppAsar(dir));

  return uniquePaths(
    moduleDirs.flatMap((dir) => [
      path.resolve(dir, '..', '..'),
      path.resolve(dir, '..', '..', '..'),
    ]),
  );
}

export function resolvePackagedResourceCandidates(...segments: string[]): string[] {
  const execDir = path.dirname(process.execPath);
  return uniquePaths([
    typeof process.resourcesPath === 'string'
      ? path.join(process.resourcesPath, ...segments)
      : null,
    path.join(execDir, 'resources', ...segments),
  ]);
}

export function resolveSourceResourceCandidates(...segments: string[]): string[] {
  const cwd = process.cwd();

  return uniquePaths([
    ...resolveSourceAppRootCandidates().map((root) => path.join(root, 'resources', ...segments)),
    isInsideAppAsar(cwd) ? null : path.join(cwd, 'resources', ...segments),
  ]);
}

export function resolveBundledResourceCandidates(options: {
  packagedSegments: string[];
  sourceSegments?: string[];
}): string[] {
  const sourceSegments = options.sourceSegments ?? options.packagedSegments;
  return uniquePaths([
    ...resolvePackagedResourceCandidates(...options.packagedSegments),
    ...resolveSourceResourceCandidates(...sourceSegments),
  ]);
}

function normalizeResolvedRuntimePath(candidatePath: string): string {
  const resolvedPath = path.resolve(candidatePath);
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function isNodeBinaryPath(candidatePath: string): boolean {
  const executableName = path.basename(candidatePath).toLowerCase();
  return executableName === 'node' || executableName === 'node.exe';
}

type RuntimeBinaryResolutionOptions = {
  envNode?: string | null;
  processExecPath?: string;
  processVersions?: NodeJS.ProcessVersions;
  pathEnv?: string;
  pathExtEnv?: string;
  platform?: NodeJS.Platform;
  pathExists?: (candidatePath: string) => boolean;
  findNodeOnPath?: () => string | null;
};

function getPathModule(platform: NodeJS.Platform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function resolveNodeBinaryOnPath(options: RuntimeBinaryResolutionOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const pathModule = getPathModule(platform);
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? '';
  const pathExists = options.pathExists ?? existsSync;
  if (!pathEnv) {
    return null;
  }

  const executableNames = platform === 'win32'
    ? (options.pathExtEnv ?? process.env.PATHEXT ?? '.EXE')
      .split(';')
      .filter(Boolean)
      .filter((extension) => extension.toLowerCase() === '.exe')
      .map((extension) => `node${extension.toLowerCase()}`)
    : ['node'];

  for (const pathEntry of pathEnv.split(pathModule.delimiter)) {
    if (!pathEntry) {
      continue;
    }
    for (const executableName of executableNames) {
      const candidate = pathModule.join(pathEntry, executableName);
      if (pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function isCurrentElectronExecutable(
  candidatePath: string,
  options: RuntimeBinaryResolutionOptions = {},
): boolean {
  const processExecPath = options.processExecPath ?? process.execPath;
  const processVersions = options.processVersions ?? process.versions;
  return Boolean(processVersions.electron)
    && normalizeResolvedRuntimePath(candidatePath) === normalizeResolvedRuntimePath(processExecPath);
}

const JS_REPL_RUNTIME_DIR_NAME = 'js-repl-runtime';

/**
 * Resolve the bundled js_repl runtime dir (contains node_modules with
 * playwright-core + interpreter-browser-control and the kernel/ payload).
 */
export function resolveBundledJsReplRuntimeDir(
  pathExists: (candidatePath: string) => boolean = existsSync,
): string {
  const candidatePaths = uniquePaths([
    ...resolveBundledResourceCandidates({ packagedSegments: [JS_REPL_RUNTIME_DIR_NAME] }),
    path.join(process.cwd(), 'resources', JS_REPL_RUNTIME_DIR_NAME),
  ]);

  for (const candidate of candidatePaths) {
    if (
      pathExists(path.join(candidate, 'node_modules', 'playwright-core', 'package.json'))
      && pathExists(path.join(candidate, 'node_modules', 'interpreter-browser-control', 'package.json'))
      && pathExists(path.join(candidate, 'kernel', 'kernel.cjs'))
    ) {
      return candidate;
    }
  }

  throw new Error(
    `[bundled-runtime] Bundled js_repl runtime not found (need node_modules and kernel/kernel.cjs). Checked: ${candidatePaths.join(', ')}. In a source checkout, run: pnpm run ensure:js-repl-runtime-assets`,
  );
}

export function resolveElectronRunAsNodeBinary(
  options: RuntimeBinaryResolutionOptions = {},
): string {
  const pathExists = options.pathExists ?? existsSync;
  const envNode = options.envNode ?? process.env.INTERPRETER_NODE_BIN?.trim() ?? '';
  if (envNode && pathExists(envNode)) {
    return envNode;
  }

  const processExecPath = options.processExecPath ?? process.execPath;
  if (pathExists(processExecPath) && (
    isCurrentElectronExecutable(processExecPath, options)
    || isNodeBinaryPath(processExecPath)
  )) {
    return processExecPath;
  }

  const pathNode = options.findNodeOnPath
    ? options.findNodeOnPath()
    : resolveNodeBinaryOnPath(options);
  if (pathNode && pathExists(pathNode)) {
    return pathNode;
  }

  throw new Error(
    `[bundled-runtime] Node-compatible js_repl binary not found. Checked INTERPRETER_NODE_BIN, current executable (${processExecPath}), and node on PATH.`,
  );
}

export function usesElectronRunAsNode(
  binaryPath: string,
  options: RuntimeBinaryResolutionOptions = {},
): boolean {
  return isCurrentElectronExecutable(binaryPath, options);
}

export function resolveElectronRunAsNodeSandboxReadableRoots(
  binaryPath: string,
  options: {
    platform?: NodeJS.Platform;
  } = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return [];
  }

  const normalizedBinaryPath = path.posix.normalize(binaryPath);
  const appContentsSegment = '/Contents/MacOS/';
  const contentsIndex = normalizedBinaryPath.indexOf(appContentsSegment);
  if (contentsIndex === -1) {
    return [];
  }

  const contentsRoot = normalizedBinaryPath.slice(0, contentsIndex + '/Contents'.length);
  return [contentsRoot];
}
