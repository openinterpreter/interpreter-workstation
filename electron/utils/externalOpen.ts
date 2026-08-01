import { statSync } from 'node:fs';
import path from 'node:path';

export const SUPPORTED_EXTERNAL_FILE_EXTENSIONS = ['.docx', '.doc', '.pdf', '.xlsx', '.md', '.markdown'] as const;

export interface ExternalOpenWindowSession {
  windowId: number;
  workspacePath: string | null;
}

export type ExternalOpenTarget =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string };

export interface ExternalAskTarget {
  kind: 'file' | 'folder';
  path: string;
}

export interface ExternalAskRequest {
  workspacePath: string;
  targets: ExternalAskTarget[];
  prompt: string;
}

export type ExternalFolderOpenWindowTarget =
  | { kind: 'focused-window'; windowId: number }
  | { kind: 'existing-workspace-window'; windowId: number }
  | { kind: 'new-window' };

function isCandidateArg(arg: string): boolean {
  return arg.length > 0 && !arg.startsWith('--') && !arg.startsWith('-') && !arg.includes('://');
}

export function isSupportedExternalFilePath(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  return SUPPORTED_EXTERNAL_FILE_EXTENSIONS.some((ext) => lowerPath.endsWith(ext));
}

export function classifyExternalOpenPath(candidatePath: string): ExternalOpenTarget | null {
  if (!isCandidateArg(candidatePath)) {
    return null;
  }

  const normalizedPath = path.resolve(candidatePath);

  let stats;
  try {
    stats = statSync(normalizedPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) {
    return { kind: 'folder', path: normalizedPath };
  }

  if (stats.isFile() && isSupportedExternalFilePath(normalizedPath)) {
    return { kind: 'file', path: normalizedPath };
  }

  return null;
}

export function findExternalOpenTargetInArgv(argv: string[]): ExternalOpenTarget | null {
  for (const arg of argv) {
    const target = classifyExternalOpenPath(arg);
    if (target) {
      return target;
    }
  }

  return null;
}

export function findExternalAskTargetsInArgv(argv: string[]): string[] {
  const askFlagIndex = argv.findIndex((arg) => arg === '--ask' || arg === '--ask-files');
  if (askFlagIndex === -1) {
    return [];
  }

  return argv
    .slice(askFlagIndex + 1)
    .filter(isCandidateArg);
}

export function createExternalAskRequest(inputPaths: string[]): ExternalAskRequest | null {
  const targets = inputPaths
    .map(classifyExternalAskPath)
    .filter((target): target is ExternalAskTarget => target !== null);

  if (targets.length === 0) {
    return null;
  }

  const workspacePath = findCommonParentDirectory(targets);
  return {
    workspacePath,
    targets,
    prompt: buildExternalAskPrompt(targets),
  };
}

function classifyExternalAskPath(candidatePath: string): ExternalAskTarget | null {
  if (!isCandidateArg(candidatePath)) {
    return null;
  }

  const normalizedPath = path.resolve(candidatePath);
  let stats;
  try {
    stats = statSync(normalizedPath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) {
    return { kind: 'folder', path: normalizedPath };
  }

  if (stats.isFile()) {
    return { kind: 'file', path: normalizedPath };
  }

  return null;
}

function findCommonParentDirectory(targets: ExternalAskTarget[]): string {
  const workspaceRoots = targets.map((target) => (
    target.kind === 'folder' ? target.path : path.dirname(target.path)
  ));
  const [firstParent, ...remainingParents] = workspaceRoots.map((parentPath) => path.resolve(parentPath));
  if (!firstParent) {
    return process.cwd();
  }

  const parsed = path.parse(firstParent);
  const commonParts = firstParent.slice(parsed.root.length).split(path.sep).filter(Boolean);

  for (const parentPath of remainingParents) {
    const parentParsed = path.parse(parentPath);
    if (parentParsed.root.toLowerCase() !== parsed.root.toLowerCase()) {
      return parsed.root;
    }

    const parentParts = parentPath.slice(parentParsed.root.length).split(path.sep).filter(Boolean);
    let index = 0;
    while (
      index < commonParts.length
      && index < parentParts.length
      && commonParts[index].toLowerCase() === parentParts[index].toLowerCase()
    ) {
      index += 1;
    }
    commonParts.length = index;
  }

  return path.join(parsed.root, ...commonParts);
}

function buildExternalAskPrompt(targets: ExternalAskTarget[]): string {
  const noun = describeExternalAskTargets(targets);
  const links = targets
    .map((target) => `- [${path.basename(target.path)}](${target.path})`)
    .join('\n');

  return `Please help me edit ${noun}:\n\n${links}`;
}

function describeExternalAskTargets(targets: ExternalAskTarget[]): string {
  if (targets.length === 1) {
    const [target] = targets;
    if (target.kind === 'folder') {
      return 'this folder';
    }
    return `this ${describeFileKind(target.path)}`;
  }

  const allFolders = targets.every((target) => target.kind === 'folder');
  if (allFolders) {
    return 'these folders';
  }

  const files = targets.filter((target) => target.kind === 'file');
  if (files.length === targets.length) {
    const fileKinds = new Set(files.map((target) => describeFileKind(target.path)));
    if (fileKinds.size === 1) {
      const [fileKind] = fileKinds;
      return `these ${pluralizeFileKind(fileKind)}`;
    }
    return 'these files';
  }

  return 'these files and folders';
}

function describeFileKind(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.pdf':
      return 'PDF';
    case '.doc':
    case '.docx':
      return 'Word document';
    case '.xls':
    case '.xlsx':
      return 'spreadsheet';
    case '.md':
    case '.markdown':
      return 'Markdown file';
    default:
      return 'file';
  }
}

function pluralizeFileKind(fileKind: string): string {
  switch (fileKind) {
    case 'PDF':
      return 'PDFs';
    case 'Word document':
      return 'Word documents';
    case 'spreadsheet':
      return 'spreadsheets';
    case 'Markdown file':
      return 'Markdown files';
    default:
      return 'files';
  }
}

export function resolveFolderOpenWindowTarget(input: {
  workspacePath: string;
  focusedWindowId?: number | null;
  windowSessions: ExternalOpenWindowSession[];
}): ExternalFolderOpenWindowTarget {
  if (input.focusedWindowId) {
    return {
      kind: 'focused-window',
      windowId: input.focusedWindowId,
    };
  }

  const existingWorkspaceWindow = input.windowSessions.find((session) => session.workspacePath === input.workspacePath);
  if (existingWorkspaceWindow) {
    return {
      kind: 'existing-workspace-window',
      windowId: existingWorkspaceWindow.windowId,
    };
  }

  return { kind: 'new-window' };
}
