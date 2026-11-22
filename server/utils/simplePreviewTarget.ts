/**
 * Which Simple project the preview proxy may forward to.
 *
 * The target is the running project most recently reported to a renderer,
 * together with the window session that selected it and whether that was the
 * session's own choice or the global one. It is honoured only while the same
 * selection still resolves to that project and the project is still running;
 * every other case resolves to no target.
 */
export type SimplePreviewSelection = { path: string; scope: 'session' | 'global' };

export type SimplePreviewTarget = SimplePreviewSelection & { sessionKey: string | null };

export type SimplePreviewTargetDependencies = {
  /** The project currently selected for the session, or null. */
  selected: (sessionKey: string | null) => Promise<SimplePreviewSelection | null>;
  /** The project server's state. */
  status: (projectPath: string) => Promise<{ status: string; url?: string | null }>;
};

/**
 * The target after a report to a renderer. A project that is not running, or
 * that is not what the reporting session has selected, clears the target.
 */
export function reportedSimplePreviewTarget(
  projectPath: string,
  running: boolean,
  sessionKey: string | null | undefined,
  selection: SimplePreviewSelection | null,
): SimplePreviewTarget | null {
  if (!running || !selection || selection.path !== projectPath) return null;
  return { path: projectPath, scope: selection.scope, sessionKey: sessionKey ?? null };
}

export async function resolveSimplePreviewTargetPort(
  target: SimplePreviewTarget | null,
  dependencies: SimplePreviewTargetDependencies,
): Promise<{ port: number | null; stale: boolean }> {
  if (!target) return { port: null, stale: false };
  // Fail closed when the selection changed since the last report. Selecting
  // another project must never leave the previous one reachable, and a target
  // chosen by a window session must not survive that session's choice going
  // away by falling back to the global selection.
  const selected = await dependencies.selected(target.sessionKey);
  if (!selected || selected.path !== target.path || selected.scope !== target.scope) {
    return { port: null, stale: true };
  }
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
