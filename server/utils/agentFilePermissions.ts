import type { FileAccessPolicyData, PermissionLevel } from '../../shared/types/permissions';
import {
  getAllowModelSkillEditingSync,
  getCodexApprovalPolicySync,
  getCodexMacosScreenshotAccessSync,
  getCodexMacosTempAccessSync,
  getCodexReadAccessModeSync,
  getCodexSandboxModeSync,
} from '../configStore';
import { getCodexMacosTrustedCustomPaths } from './codexTrustedPaths';
import { getGlobalSkillsRoot } from './skillsPaths';

export type EffectiveFileReadAccess = 'folder' | 'anywhere';
export type EffectiveFileWriteAccess = 'ask-first' | 'folder' | 'anywhere';
export type EffectiveTempAccess = 'none' | 'read' | 'write';

export function deriveEffectiveFileReadAccess(
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access',
  readAccessMode: 'workspace-only' | 'full-system',
): EffectiveFileReadAccess {
  if (sandboxMode === 'danger-full-access' || readAccessMode === 'full-system') {
    return 'anywhere';
  }
  return 'folder';
}

export function deriveEffectiveFileWriteAccess(
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access',
  approvalPolicy: 'never' | 'on-failure' | 'on-request' | 'untrusted',
): EffectiveFileWriteAccess {
  if (sandboxMode === 'danger-full-access') {
    return 'anywhere';
  }
  if (approvalPolicy === 'on-request' || approvalPolicy === 'untrusted' || sandboxMode === 'read-only') {
    return 'ask-first';
  }
  return 'folder';
}

export function deriveEffectiveTempAccess(
  tempAccessEnabled: boolean,
  screenshotAccessEnabled: boolean,
): EffectiveTempAccess {
  if (tempAccessEnabled) {
    return 'write';
  }
  if (screenshotAccessEnabled) {
    return 'read';
  }
  return 'none';
}

export function getEffectiveFileReadAccessSync(): EffectiveFileReadAccess {
  return deriveEffectiveFileReadAccess(
    getCodexSandboxModeSync(),
    getCodexReadAccessModeSync(),
  );
}

export function getEffectiveFileWriteAccessSync(): EffectiveFileWriteAccess {
  return deriveEffectiveFileWriteAccess(
    getCodexSandboxModeSync(),
    getCodexApprovalPolicySync(),
  );
}

export function getEffectiveTempAccessSync(): EffectiveTempAccess {
  return deriveEffectiveTempAccess(
    getCodexMacosTempAccessSync(),
    getCodexMacosScreenshotAccessSync(),
  );
}

function getSystemPermissionLevel(): PermissionLevel {
  if (getEffectiveFileWriteAccessSync() === 'anywhere') {
    return 'write';
  }
  if (getEffectiveFileReadAccessSync() === 'anywhere') {
    return 'read';
  }
  return 'none';
}

function getWorkspacePermissionLevel(): PermissionLevel {
  if (getEffectiveFileWriteAccessSync() === 'ask-first') {
    return 'read';
  }
  return 'write';
}

export function getGlobalAgentFileAccessPolicySync(): FileAccessPolicyData {
  const customPaths = {
    ...getCodexMacosTrustedCustomPaths({
      tempAccessEnabled: getCodexMacosTempAccessSync(),
      screenshotAccessEnabled: getCodexMacosScreenshotAccessSync(),
    }),
  };

  customPaths[getGlobalSkillsRoot()] = getAllowModelSkillEditingSync() ? 'write' : 'read';

  return {
    system: getSystemPermissionLevel(),
    workspace: getWorkspacePermissionLevel(),
    customPaths,
  };
}

export function shouldPromptForWorkspaceWriteSync(): boolean {
  return getEffectiveFileWriteAccessSync() === 'ask-first';
}
