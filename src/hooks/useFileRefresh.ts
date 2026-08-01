import { useEffect, useRef } from 'react';
import { files, workspace, pathsMatch } from '@/ipc';
import type { FileRefreshedEvent, WorkspaceFilesChangedEvent } from '../../electron/ipc/registry';

type FileChangeEvent = WorkspaceFilesChangedEvent & { eventType: 'change' | 'add'; path: string };
type FileRefreshHandlers = {
  onAgentRefresh?: () => void;
  onExternalRefresh?: () => void;
};

function isFileChangeEvent(event: WorkspaceFilesChangedEvent): event is FileChangeEvent {
  return (event.eventType === 'change' || event.eventType === 'add') && !!event.path;
}

function shouldRefreshFromWorkspaceEvent(
  event: WorkspaceFilesChangedEvent,
  filePath: string,
): boolean {
  return isFileChangeEvent(event) && pathsMatch(filePath, event.path);
}

function normalizeHandlers(handlers: (() => void) | FileRefreshHandlers): FileRefreshHandlers {
  if (typeof handlers === 'function') {
    return {
      onAgentRefresh: handlers,
      onExternalRefresh: handlers,
    };
  }

  return handlers;
}

export function useFileRefresh(
  filePath: string,
  handlers: (() => void) | FileRefreshHandlers,
): void {
  const handlersRef = useRef<FileRefreshHandlers>(normalizeHandlers(handlers));
  const lastRefreshAtRef = useRef(0);

  useEffect(() => {
    handlersRef.current = normalizeHandlers(handlers);
  }, [handlers]);

  useEffect(() => {
    const refresh = (source: 'agent' | 'external') => {
      const now = Date.now();
      if (now - lastRefreshAtRef.current < 150) return;
      lastRefreshAtRef.current = now;
      if (source === 'agent') {
        handlersRef.current.onAgentRefresh?.();
        return;
      }
      handlersRef.current.onExternalRefresh?.();
    };

    const unsubscribeWorkspace = workspace.onFilesChanged((event: WorkspaceFilesChangedEvent) => {
      if (shouldRefreshFromWorkspaceEvent(event, filePath)) {
        refresh('external');
      }
    });

    const unsubscribeFiles = files.onRefreshed((event: FileRefreshedEvent) => {
      if (pathsMatch(filePath, event.filePath)) {
        refresh('agent');
      }
    });

    return () => {
      unsubscribeWorkspace();
      unsubscribeFiles();
    };
  }, [filePath]);
}
