export const HEADLESS_TASK_WORKSPACE_ERROR = 'workspace is required for headless tasks';
export const HEADLESS_TASK_CLI_WORKSPACE_ERROR = '--workspace is required for headless task runs';

type HeadlessWorkspaceTaskMode = 'headed' | 'headless';

export function normalizeHeadlessTaskWorkspace(
  workspace: string | null | undefined,
): string | undefined {
  if (typeof workspace !== 'string') {
    return undefined;
  }

  const normalizedWorkspace = workspace.trim();
  return normalizedWorkspace ? normalizedWorkspace : undefined;
}

export function getProgrammaticTaskWorkspaceError(
  mode: HeadlessWorkspaceTaskMode,
  workspace?: string,
): string | null {
  if (mode !== 'headless') {
    return null;
  }

  if (!normalizeHeadlessTaskWorkspace(workspace)) {
    return HEADLESS_TASK_WORKSPACE_ERROR;
  }

  return null;
}

export function getHeadlessTaskCliWorkspaceError(
  workspace?: string,
): string | null {
  if (normalizeHeadlessTaskWorkspace(workspace)) {
    return null;
  }

  return HEADLESS_TASK_CLI_WORKSPACE_ERROR;
}
