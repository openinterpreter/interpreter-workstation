/**
 * Sandbox access is always allowed by the file-access checks, so this helper is
 * now just an explicit breadcrumb for callers that still invoke it.
 */
export function noteSandboxAccessAllowed(requesterId: string): void {
  console.log('[SandboxPermissions] Sandbox access is already allowed for', requesterId);
}
