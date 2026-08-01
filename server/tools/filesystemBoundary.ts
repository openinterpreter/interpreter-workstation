// NOTE(filesystem-approvals): Filesystem boundary enforcement for toolManager.callTool().
//
// Problem: callTool() is the single choke point for all builtin tool execution
// (CLI, Codex MCP bridge, HTTP routes, IPC, inbox). Filesystem checks must
// live here so every caller hits the same boundary before the tool handler.
//
// This module extracts the boundary checks so callTool() can enforce them for
// ALL callers. Builtin tool `fileAccess` metadata becomes read/write checks
// here, and `server/tools/filesystemGuard.ts` owns the user-approval branch
// when policy says "ask".

import type { BuiltinToolDefinition } from './builtinTools';
import {
  checkFileAccessPermissionAsync as realCheckFileAccessPermissionAsync,
  getFileAccessDeniedMessage as realGetFileAccessDeniedMessage,
  resolvePathWithWorkspace,
} from '../utils/permissions';
import {
  authorizeFileWriteAccess as realAuthorizeFileWriteAccess,
  createDenialResponse,
} from './filesystemGuard';

interface BoundaryParams {
  builtinTool: BuiltinToolDefinition;
  args: Record<string, any>;
  workspace: string | null;
  serverId: string;
  toolCallId?: string;
  agentId?: string;
}

interface BoundaryDeps {
  authorizeFileWriteAccess: typeof realAuthorizeFileWriteAccess;
  checkFileAccessPermissionAsync: typeof realCheckFileAccessPermissionAsync;
  getFileAccessDeniedMessage: typeof realGetFileAccessDeniedMessage;
}

const defaultDeps: BoundaryDeps = {
  authorizeFileWriteAccess: realAuthorizeFileWriteAccess,
  checkFileAccessPermissionAsync: realCheckFileAccessPermissionAsync,
  getFileAccessDeniedMessage: realGetFileAccessDeniedMessage,
};

function getEffectiveAgentId(agentId?: string): string {
  return agentId ?? 'filesystem-boundary';
}

function getStringPathInputs(rawValue: unknown): string[] {
  if (typeof rawValue === 'string') {
    return [rawValue];
  }

  if (Array.isArray(rawValue)) {
    return rawValue.filter((item): item is string => typeof item === 'string');
  }

  return [];
}

/**
 * Enforce filesystem boundaries for a builtin tool call.
 *
 * Returns `null` to allow execution, or a denial response to block it.
 * - Write outside workspace: triggers approval flow.
 * - Read outside workspace: triggers approval flow.
 */
export async function enforceFilesystemBoundary(
  params: BoundaryParams,
  deps: Partial<BoundaryDeps> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean } | null> {
  const { builtinTool, args, workspace, toolCallId, agentId } = params;
  const resolvedDeps: BoundaryDeps = { ...defaultDeps, ...deps };

  if (!builtinTool.fileAccess || !workspace) return null;

  const pathArgs = Array.isArray(builtinTool.fileAccess.pathArg)
    ? builtinTool.fileAccess.pathArg
    : [builtinTool.fileAccess.pathArg];

  const effectiveAgentId = getEffectiveAgentId(agentId);

  for (const argName of pathArgs) {
    const accessMode = builtinTool.fileAccess.pathArgModes?.[argName] ?? builtinTool.fileAccess.mode;

    for (const rawPath of getStringPathInputs(args[argName])) {
      let resolvedPath: string;
      try {
        resolvedPath = resolvePathWithWorkspace(rawPath, workspace);
      } catch {
        continue;
      }

      if (accessMode === 'write') {
        const writeAuth = await resolvedDeps.authorizeFileWriteAccess({
          agentId: effectiveAgentId,
          filePath: resolvedPath,
          workspace,
          toolCallId,
        });
        if (!writeAuth.allowed) {
          if (writeAuth.deniedByUser) {
            return createDenialResponse('write', resolvedPath);
          }
          return {
            content: [{
              type: 'text',
              text: writeAuth.message ?? resolvedDeps.getFileAccessDeniedMessage(
                effectiveAgentId,
                resolvedPath,
                'write',
                workspace,
              ),
            }],
            isError: true,
          };
        }
        continue;
      }

      const allowed = await resolvedDeps.checkFileAccessPermissionAsync(
        effectiveAgentId,
        resolvedPath,
        accessMode,
        workspace,
      );
      if (!allowed) {
        return {
          content: [{
            type: 'text',
            text: resolvedDeps.getFileAccessDeniedMessage(
              effectiveAgentId,
              resolvedPath,
              accessMode,
              workspace,
            ),
          }],
          isError: true,
        };
      }
    }
  }

  return null;
}
