/**
 * ACP provider compatibility shim.
 *
 * ACP support was removed. These exports remain only so legacy code paths
 * fail fast with a clear error instead of crashing on missing imports.
 */

function acpRemovedError(): Error {
  return new Error('ACP provider is no longer supported. Use Codex profiles instead.');
}

export async function getOrCreateACPProvider(..._args: any[]): Promise<{ languageModel: () => any }> {
  throw acpRemovedError();
}

export function cleanupACPProvider(..._args: any[]): void {
  // no-op: ACP providers are not created anymore
}

export async function cleanupAllACPProviders(..._args: any[]): Promise<void> {
  // no-op: ACP providers are not created anymore
}

export async function wrapToolsForACP(..._args: any[]): Promise<Record<string, any>> {
  throw acpRemovedError();
}
