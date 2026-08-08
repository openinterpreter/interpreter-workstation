import type { v2 } from "../../../server/handlers/codex-generated-types/index";

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexReadAccessMode = 'workspace-only' | 'full-system';

export const DEFAULT_CODEX_SANDBOX_MODE: CodexSandboxMode = 'workspace-write';
export const DEFAULT_CODEX_READ_ACCESS_MODE: CodexReadAccessMode = 'full-system';
export const WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID =
  'interpreter-workspace-scope';

export type CodexWorkspacePermissionSelection = {
  permissionProfileId: string;
  runtimeWorkspaceRoots: string[];
  config: Record<string, unknown>;
};

/**
 * Translate Workstation's persisted access settings into the standard upstream
 * OIX/Codex sandbox policy accepted by `turn/start`.
 *
 * Workstation's own CLI/tool boundary continues to enforce its more detailed
 * file policy. OIX owns shell execution, so the app sends only the upstream
 * sandbox shape instead of the fork-only `PermissionProfile` extension.
 */
export function buildCodexSandboxPolicy(options: {
  sandboxMode: CodexSandboxMode;
  networkAccess: boolean;
  writableRoots?: string[];
  allowTempAccess?: boolean | null;
}): v2.SandboxPolicy {
  if (options.sandboxMode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }

  if (options.sandboxMode === 'read-only') {
    return {
      type: 'readOnly',
      networkAccess: options.networkAccess,
    };
  }

  const writableRoots = Array.from(
    new Set((options.writableRoots ?? []).map((root) => root.trim()).filter(Boolean)),
  );
  const allowTempAccess = options.allowTempAccess ?? true;

  return {
    type: 'workspaceWrite',
    writableRoots,
    networkAccess: options.networkAccess,
    excludeTmpdirEnvVar: !allowTempAccess,
    excludeSlashTmp: !allowTempAccess,
  };
}

/**
 * Build the OIX named-permission profile used when Workstation's read scope is
 * workspace-only. The legacy app-server SandboxPolicy can constrain writes but
 * deliberately grants broad reads; OIX permission profiles are the contract
 * that constrains both.
 *
 * OIX's experimental permission-profile fields are enabled by our initialize
 * handshake. They are present in the pinned public runtime even though its
 * stable generated TypeScript projection omits experimental request fields.
 */
export function buildCodexWorkspacePermissionSelection(options: {
  sandboxMode: CodexSandboxMode;
  readAccessMode: CodexReadAccessMode;
  networkAccess: boolean;
  allowTempAccess?: boolean | null;
  cwd?: string | null;
  additionalReadableRoots?: string[];
  additionalWritableRoots?: string[];
}): CodexWorkspacePermissionSelection | null {
  if (options.readAccessMode !== 'workspace-only') {
    return null;
  }

  const workspaceAccess = options.sandboxMode === 'read-only' ? 'read' : 'write';
  const filesystem: Record<string, unknown> = {
    ':minimal': 'read',
    ':workspace_roots': {
      '.': workspaceAccess,
    },
  };

  if (options.allowTempAccess ?? true) {
    filesystem[':tmpdir'] = workspaceAccess;
  }

  for (const readableRoot of options.additionalReadableRoots ?? []) {
    const normalizedRoot = readableRoot.trim();
    if (normalizedRoot) {
      filesystem[normalizedRoot] = 'read';
    }
  }

  for (const writableRoot of options.additionalWritableRoots ?? []) {
    const normalizedRoot = writableRoot.trim();
    if (normalizedRoot) {
      filesystem[normalizedRoot] = 'write';
    }
  }

  return {
    permissionProfileId: WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID,
    runtimeWorkspaceRoots: options.cwd?.trim() ? [options.cwd.trim()] : [],
    config: {
      permissions: {
        [WORKSTATION_WORKSPACE_PERMISSION_PROFILE_ID]: {
          filesystem,
          network: {
            enabled: options.networkAccess,
          },
        },
      },
    },
  };
}
