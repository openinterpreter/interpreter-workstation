import { pathsMatch } from '@/ipc';
import type { WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';

function isMarkdownNotePath(filePath: string | undefined): boolean {
  return Boolean(filePath && /\.(md|markdown)$/i.test(filePath));
}

export function shouldRefreshUnlinkedMentionCandidatesFromWorkspaceEvent(
  event: WorkspaceFilesChangedEvent,
  currentFilePath: string,
): boolean {
  if ((event.eventType !== 'add' && event.eventType !== 'unlink') || !event.path) {
    return false;
  }

  if (!isMarkdownNotePath(event.path)) {
    return false;
  }

  return !pathsMatch(currentFilePath, event.path);
}
