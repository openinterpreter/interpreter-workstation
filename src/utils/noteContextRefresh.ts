import { pathsMatch } from '@/ipc';
import type { WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';

function isMarkdownNotePath(filePath: string | undefined): boolean {
  return Boolean(filePath && /\.(md|markdown)$/i.test(filePath));
}

export function shouldRefreshNoteContextFromWorkspaceEvent(
  event: WorkspaceFilesChangedEvent,
  currentFilePath: string,
): boolean {
  if (!event.path || !isMarkdownNotePath(event.path)) {
    return false;
  }

  if (pathsMatch(currentFilePath, event.path)) {
    return event.eventType === 'add' || event.eventType === 'change' || event.eventType === 'unlink';
  }

  return event.eventType === 'add' || event.eventType === 'unlink';
}
