/**
 * Shared type definitions for file-access policy.
 *
 * IMPORTANT: This is the SINGLE SOURCE OF TRUTH for file-access policy types.
 * All other files should import from here.
 */

/**
 * Permission level for file system access
 */
export type PermissionLevel = 'none' | 'read' | 'write';

/**
 * Resolved file-access policy (storage/serialization format)
 * Uses Record for JSON serialization over IPC
 */
export interface FileAccessPolicyData {
  system: PermissionLevel;
  workspace: PermissionLevel;
  customPaths: Record<string, PermissionLevel>;
}

/**
 * Resolved file-access policy (runtime format)
 * Uses Map for easier iteration and manipulation
 */
export interface FileAccessPolicy {
  system: PermissionLevel;
  workspace: PermissionLevel;
  customPaths: Map<string, PermissionLevel>;
}

/**
 * Default resolved file-access policy
 */
export const DEFAULT_FILE_ACCESS_POLICY: FileAccessPolicyData = {
  system: 'read',
  workspace: 'write',
  customPaths: {},
};

/**
 * Convert storage format to runtime format
 */
export function toRuntimeFileAccessPolicy(
  data: FileAccessPolicyData,
): FileAccessPolicy {
  return {
    system: data.system,
    workspace: data.workspace,
    customPaths: new Map(Object.entries(data.customPaths || {})),
  };
}

/**
 * Convert runtime format to storage format
 */
export function toStorageFileAccessPolicy(
  policy: FileAccessPolicy | FileAccessPolicyData,
): FileAccessPolicyData {
  if (!(policy.customPaths instanceof Map)) {
    return policy as FileAccessPolicyData;
  }

  return {
    system: policy.system,
    workspace: policy.workspace,
    customPaths: Object.fromEntries(policy.customPaths),
  };
}
