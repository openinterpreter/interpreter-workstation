// Resolves the effective file-access policy from global settings.

import {
  type FileAccessPolicyData,
} from '../shared/types/permissions';
import { getGlobalAgentFileAccessPolicySync } from './utils/agentFilePermissions';

class GlobalFileAccessResolver {
  /**
   * Resolve the effective file-access policy for a requester.
   *
   * File permissions are global now, so `requesterId` is used only for logs.
   * The resolved policy still includes runtime-added trusted paths such as the
   * skills root and platform-specific trusted directories.
   */
  resolveForRequester(requesterId: string): FileAccessPolicyData {
    const policy = getGlobalAgentFileAccessPolicySync();

    console.log('[GlobalFileAccessResolver] Resolved policy for', requesterId, JSON.stringify(policy));
    return policy;
  }

  clearRequester(requesterId: string): void {
    console.log('[GlobalFileAccessResolver] clearRequester is a no-op for', requesterId);
  }

  hasResolvedPolicy(_requesterId: string): boolean {
    return true;
  }
}

export const globalFileAccessResolver = new GlobalFileAccessResolver();
