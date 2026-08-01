/**
 * Filesystem Guard - Configurable approval system for file operations
 *
 * Checks the live global runtime permission settings on each call.
 * If user changes a setting, the next tool call picks it up immediately.
 */

import { realpath } from 'node:fs/promises';
import {
  checkFileAccessPermissionAsync,
  getFileAccessDeniedMessage,
  isSamePathOrDescendant,
  normalizePath,
  resolvePathForSecurityCheck,
} from '../utils/permissions';
import { approvalManager } from '../approvalManager';
import { getGlobalSkillsRoot } from '../utils/skillsPaths';
import {
  getEffectiveFileReadAccessSync,
  shouldPromptForWorkspaceWriteSync,
} from '../utils/agentFilePermissions';

// Virtual tool names for session tracking
export const FS_GUARD_CATEGORIES = {
  WRITE: 'fs_guard:write',
  READ_OUTSIDE: 'fs_guard:read_outside',
  WRITE_OUTSIDE: 'fs_guard:write_outside',
  DELETE: 'fs_guard:delete',
  COPY: 'fs_guard:copy',
  MOVE: 'fs_guard:move',
} as const;

type FsGuardCategory = typeof FS_GUARD_CATEGORIES[keyof typeof FS_GUARD_CATEGORIES];

const WARNING_MESSAGES: Record<FsGuardCategory, string> = {
  [FS_GUARD_CATEGORIES.WRITE]: 'Interpreter wants to change files in this workspace.',
  [FS_GUARD_CATEGORIES.READ_OUTSIDE]: 'Interpreter wants to read a file outside your workspace.',
  [FS_GUARD_CATEGORIES.WRITE_OUTSIDE]: 'Interpreter wants to write to a file outside your workspace.',
  [FS_GUARD_CATEGORIES.DELETE]: 'Interpreter wants to delete a file.\n\nDeleted files are moved to trash and can be recovered.',
  [FS_GUARD_CATEGORIES.COPY]: 'Interpreter wants to copy files.',
  [FS_GUARD_CATEGORIES.MOVE]: 'Interpreter wants to move or rename files.',
};

async function canonicalizeRoot(rootPath: string): Promise<string> {
  return resolvePathForSecurityCheck(rootPath);
}

/**
 * Check if a resolved path is outside the workspace after canonicalizing
 * symlinks and workspace aliases.
 *
 * Returns false if no workspace is set (no approval needed).
 */
export async function isOutsideWorkspace(
  resolvedPath: string,
  workspace: string | null,
): Promise<boolean> {
  if (!workspace) return false;

  const [canonicalPath, canonicalWorkspace] = await Promise.all([
    resolvePathForSecurityCheck(resolvedPath),
    canonicalizeRoot(workspace),
  ]);

  return !isPathWithinRoot(canonicalPath, canonicalWorkspace);
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = normalizePath(candidatePath);
  const normalizedRoot = normalizePath(rootPath);
  return isSamePathOrDescendant(normalizedCandidate, normalizedRoot);
}

/**
 * Trusted global skills reads are auto-approved.
 * Uses realpath checks to prevent symlink escapes from the skills directory.
 */
export async function isTrustedGlobalSkillReadPath(candidatePath: string): Promise<boolean> {
  const skillsRoot = normalizePath(getGlobalSkillsRoot());
  if (!isPathWithinRoot(candidatePath, skillsRoot)) return false;

  try {
    const [realCandidate, realSkillsRoot] = await Promise.all([
      realpath(candidatePath),
      realpath(skillsRoot),
    ]);
    return isPathWithinRoot(realCandidate, realSkillsRoot);
  } catch {
    return false;
  }
}

async function filterTrustedGlobalSkillReadPaths(paths: string[]): Promise<string[]> {
  const uniquePaths = Array.from(new Set(paths.map((filePath) => normalizePath(filePath))));
  const pathsRequiringApproval: string[] = [];

  for (const filePath of uniquePaths) {
    if (!(await isTrustedGlobalSkillReadPath(filePath))) {
      pathsRequiringApproval.push(filePath);
    }
  }

  return pathsRequiringApproval;
}

interface FilesystemApprovalArgs {
  category: FsGuardCategory;
  paths: string[];
  description?: string;
  toolCallId?: string;
  agentId?: string;
}

/**
 * Request approval for a filesystem operation.
 * Checks settings LIVE for copy/move/read-outside operations.
 * Delete approvals are always required.
 *
 * NOTE(filesystem-approvals): File policy and user approval are separate layers. This
 * function only asks when policy resolves to "ask"; reads can deny without a
 * prompt, deletes always prompt, and workspace writes can use session approval.
 * The actual queue lives in `server/approvalManager.ts`.
 */
export async function requestFilesystemApproval(
  args: FilesystemApprovalArgs
): Promise<{ approved: boolean }> {
  let approvalPaths = args.paths;

  // Reads under the trusted global skills folder should never prompt.
  if (args.category === FS_GUARD_CATEGORIES.READ_OUTSIDE) {
    approvalPaths = await filterTrustedGlobalSkillReadPaths(args.paths);
    if (approvalPaths.length === 0) {
      return { approved: true };
    }

    return { approved: getEffectiveFileReadAccessSync() === 'anywhere' };
  }

  // Delete approvals are ALWAYS required (no settings bypass, no session auto-allow).
  if (args.category === FS_GUARD_CATEGORIES.DELETE) {
    const warning = WARNING_MESSAGES[args.category];
    const context: Record<string, any> = {
      message: 'Let Interpreter delete this file?',
      warning,
      paths: approvalPaths,
    };
    if (args.description) {
      context.description = args.description;
    }

    const approved = await approvalManager.createApproval(
      args.category,
      'builtin:filesystem',
      context,
      0,
      args.toolCallId,
      args.agentId,
    );
    return { approved };
  }

  if (args.category === FS_GUARD_CATEGORIES.COPY && !shouldPromptForWorkspaceWriteSync()) return { approved: true };
  if (args.category === FS_GUARD_CATEGORIES.MOVE && !shouldPromptForWorkspaceWriteSync()) return { approved: true };
  if (args.category === FS_GUARD_CATEGORIES.WRITE && !shouldPromptForWorkspaceWriteSync()) return { approved: true };
  if (args.category === FS_GUARD_CATEGORIES.WRITE_OUTSIDE) return { approved: false };

  const warning = WARNING_MESSAGES[args.category];
  const context: Record<string, any> = { paths: approvalPaths };
  if (args.description) {
    context.description = args.description;
  }

  const result = await approvalManager.createSessionAwareApproval(
    args.category,       // toolName (virtual)
    'builtin:filesystem', // serverId
    context,
    warning,
    0,                   // 0 = wait indefinitely for user
    args.toolCallId,
    args.agentId,
  );

  return { approved: result.approved };
}

/**
 * Standard denial response for filesystem operations.
 */
export function createDenialResponse(operation: string, filePath?: string) {
  const pathSuffix = filePath ? `: ${filePath}` : '';
  return {
    content: [{
      type: 'text',
      text: `Operation denied by user: ${operation}${pathSuffix}`,
    }],
    isError: false,
  };
}

interface WorkspaceWriteApprovalArgs {
  agentId: string;
  filePath: string;
  workspace: string | null;
  toolCallId?: string;
  description?: string;
}

export async function authorizeFileWriteAccess(
  args: WorkspaceWriteApprovalArgs,
): Promise<{
  allowed: boolean;
  deniedByUser?: boolean;
  message?: string;
}> {
  const allowed = await checkFileAccessPermissionAsync(
    args.agentId,
    args.filePath,
    'write',
    args.workspace,
  );
  if (allowed) {
    return { allowed: true };
  }

  if (!shouldPromptForWorkspaceWriteSync()) {
    return {
      allowed: false,
      message: getFileAccessDeniedMessage(
        args.agentId,
        args.filePath,
        'write',
        args.workspace,
      ),
    };
  }

  if (await isOutsideWorkspace(args.filePath, args.workspace)) {
    return {
      allowed: false,
      message: getFileAccessDeniedMessage(
        args.agentId,
        args.filePath,
        'write',
        args.workspace,
      ),
    };
  }

  const { approved } = await requestFilesystemApproval({
    category: FS_GUARD_CATEGORIES.WRITE,
    paths: [args.filePath],
    description: args.description,
    toolCallId: args.toolCallId,
    agentId: args.agentId,
  });
  if (!approved) {
    return { allowed: false, deniedByUser: true };
  }

  return { allowed: true };
}
