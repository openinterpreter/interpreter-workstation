import type { BroadcastScope } from '../../server/handlers/broadcast';
import type { WindowSessionRecord } from '../../server/utils/windowSessions';

type BroadcastWindowLike = {
  id: number;
  isDestroyed(): boolean;
};

function getLiveWindowIds(
  windows: readonly BroadcastWindowLike[],
): Set<number> {
  return new Set(
    windows
      .filter((window) => !window.isDestroyed())
      .map((window) => window.id),
  );
}

function selectSessionWindowIds(
  sessions: readonly WindowSessionRecord[],
  predicate: (session: WindowSessionRecord) => boolean,
): number[] {
  return sessions
    .filter(predicate)
    .map((session) => session.windowId);
}

export function getBroadcastWindowIds(
  scope: BroadcastScope | undefined,
  sessions: readonly WindowSessionRecord[],
  windows: readonly BroadcastWindowLike[],
): number[] {
  const liveWindowIds = getLiveWindowIds(windows);

  const sessionWindowIds = scope?.windowSessionKey
    ? selectSessionWindowIds(
        sessions,
        (session) => session.sessionKey === scope.windowSessionKey,
      )
    : Object.prototype.hasOwnProperty.call(scope ?? {}, 'workspacePath')
      ? selectSessionWindowIds(
          sessions,
          (session) => session.workspacePath === scope?.workspacePath,
        )
      : selectSessionWindowIds(sessions, () => true);

  return sessionWindowIds.filter((windowId) => liveWindowIds.has(windowId));
}
