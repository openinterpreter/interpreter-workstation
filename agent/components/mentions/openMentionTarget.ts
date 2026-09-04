import { isAbsolutePath, pathJoin, pathNormalize } from '../../../src/ipc';
import { getWorkspacePathSnapshot } from '../../../src/stores/workspaceStore';

type MentionTarget = {
  path: string;
  itemType: 'file' | 'directory';
  fragment?: string;
  lineStart?: number;
  lineEnd?: number;
};

type MentionWindowingApi = {
  openFile?: (path: string) => void;
  openFolder?: (path: string) => void;
};

type MentionOpenDeps = {
  windowingApi?: MentionWindowingApi;
  scheduleScroll?: (detail: { path: string; fragment?: string; lineStart?: number; lineEnd?: number }) => void;
  workspacePath?: string | null;
};

function getWindowingApi(): MentionWindowingApi | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (window as { windowingAPI?: MentionWindowingApi }).windowingAPI;
}

function defaultScheduleScroll(detail: { path: string; fragment?: string; lineStart?: number; lineEnd?: number }): void {
  if (typeof window === 'undefined') {
    return;
  }

  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('mention:scroll-to', { detail }));
  }, 300);
}

export function openMentionTarget(
  target: MentionTarget,
  deps: MentionOpenDeps = {},
): void {
  const windowingApi = deps.windowingApi ?? getWindowingApi();
  if (!windowingApi || !target.path) {
    return;
  }

  const workspacePath = deps.workspacePath === undefined
    ? getWorkspacePathSnapshot()
    : deps.workspacePath;
  const resolvedPath = !isAbsolutePath(target.path) && workspacePath
    ? pathNormalize(pathJoin(workspacePath, target.path))
    : target.path;

  if (target.itemType === 'directory') {
    windowingApi.openFolder?.(resolvedPath);
    return;
  }

  windowingApi.openFile?.(resolvedPath);

  if (target.fragment || target.lineStart != null) {
    (deps.scheduleScroll ?? defaultScheduleScroll)({
      path: resolvedPath,
      fragment: target.fragment,
      lineStart: target.lineStart,
      lineEnd: target.lineEnd,
    });
  }
}
