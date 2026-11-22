/**
 * Which Simple project the preview proxy may forward to.
 *
 * The target is the running project most recently reported to a renderer,
 * together with the window session that selected it. It is honoured only
 * while that project is still the session's selected project and is still
 * running; every other case resolves to no target.
 */
export type SimplePreviewTarget = { path: string; sessionKey: string | null };

export type SimplePreviewTargetDependencies = {
  /** The project path currently selected for the session, or null. */
  selectedPath: (sessionKey: string | null) => Promise<string | null>;
  /** The project server's state. */
  status: (projectPath: string) => Promise<{ status: string; url?: string | null }>;
};

/** A report about a project that is not running clears the target. */
export function reportedSimplePreviewTarget(
  projectPath: string,
  running: boolean,
  sessionKey: string | null | undefined,
): SimplePreviewTarget | null {
  return running ? { path: projectPath, sessionKey: sessionKey ?? null } : null;
}

export async function resolveSimplePreviewTargetPort(
  target: SimplePreviewTarget | null,
  dependencies: SimplePreviewTargetDependencies,
): Promise<{ port: number | null; stale: boolean }> {
  if (!target) return { port: null, stale: false };
  // Fail closed when the selection changed since the last report: selecting
  // another project must never leave the previous one reachable.
  const selected = await dependencies.selectedPath(target.sessionKey);
  if (selected !== target.path) return { port: null, stale: true };
  const state = await dependencies.status(target.path);
  if (state.status !== 'running' || !state.url) return { port: null, stale: false };
  let port: number;
  try {
    port = Number(new URL(state.url).port);
  } catch {
    return { port: null, stale: false };
  }
  return { port: Number.isInteger(port) && port > 0 ? port : null, stale: false };
}
