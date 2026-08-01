import type {
  BrowserControlConnection,
  BrowserControlStatus,
  BrowserControlTarget,
} from '../../shared/types/browserControl';

export interface BrowserSplitOfferTarget {
  extensionId: string;
  targetId: string;
  title: string;
  url: string;
  browserName: string | null;
}

function findUserControlledTarget(connection: BrowserControlConnection): BrowserControlTarget | null {
  return connection.targets.find((target) => target.controlSource === 'user') ?? null;
}

export function getBrowserSplitOfferTarget(
  previousActiveSessions: number | null,
  status: BrowserControlStatus,
): BrowserSplitOfferTarget | null {
  if (previousActiveSessions !== 0 || status.activeSessions !== 1) {
    return null;
  }

  for (const connection of status.connections) {
    if (connection.activeSessions <= 0) {
      continue;
    }

    const target = findUserControlledTarget(connection);
    if (!target) {
      continue;
    }

    return {
      extensionId: connection.extensionId,
      targetId: target.targetId,
      title: target.title,
      url: target.url,
      browserName: connection.browserName,
    };
  }

  return null;
}
