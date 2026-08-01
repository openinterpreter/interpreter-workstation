import path from 'node:path';
import type { OverlayOpenWorkspaceOption } from '../shared/ipc.js';

type OpenWorkspaceSession = {
  sessionKey: string;
  windowId: number;
  workspacePath: string;
};

export function buildOverlayOpenWorkspaceOptions(
  openSessions: OpenWorkspaceSession[],
): OverlayOpenWorkspaceOption[] {
  const sessionCountByWorkspacePath = new Map<string, number>();
  for (const session of openSessions) {
    sessionCountByWorkspacePath.set(
      session.workspacePath,
      (sessionCountByWorkspacePath.get(session.workspacePath) ?? 0) + 1,
    );
  }

  return openSessions.map((session) => {
    const workspaceName = path.basename(session.workspacePath) || session.workspacePath;
    const duplicatePathCount = sessionCountByWorkspacePath.get(session.workspacePath) ?? 0;
    const label = duplicatePathCount > 1
      ? `${workspaceName} (Window ${session.windowId})`
      : workspaceName;

    return {
      sessionKey: session.sessionKey,
      windowId: session.windowId,
      workspacePath: session.workspacePath,
      workspaceName,
      label,
    };
  });
}
