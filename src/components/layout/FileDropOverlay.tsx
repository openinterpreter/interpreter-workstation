import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  AGENT_SIDEBAR_ID,
  FILE_TREE_ID,
  PANE_CONTENT_ANY_SELECTOR,
} from '../../../shared/element-ids';
import { hasNativeFileDrag, isResolvedFileDrag } from '../../utils/fileDragData';
import { createInactivityWatchdog, type InactivityWatchdog } from '../../utils/inactivityWatchdog';

type FileDropSurfaceKind = 'sidebar' | 'composer' | 'pane';
const DRAG_INACTIVITY_TIMEOUT_MS = 2000;

interface FileDropSurface {
  kind: FileDropSurfaceKind;
  element: HTMLElement;
}

function logFileDropOverlay(event: string, detail?: Record<string, unknown>): void {
  console.log('[file-drag-debug]', `overlay:${event}`, detail ?? {});
}

function isSyntheticDragEvent(event: Event): boolean {
  return Boolean((event as DragEvent & { __fileDragSynthetic?: boolean }).__fileDragSynthetic);
}

function isPointInsideRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return (
    clientX >= rect.left
    && clientX <= rect.right
    && clientY >= rect.top
    && clientY <= rect.bottom
  );
}

function isOutsideWindow(clientX: number, clientY: number): boolean {
  return (
    clientX < 0
    || clientY < 0
    || clientX > window.innerWidth
    || clientY > window.innerHeight
  );
}

function hasVisibleRect(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isHiddenPersistentPaneElement(element: HTMLElement): boolean {
  const persistentContainer = element.closest<HTMLElement>('[data-persistent-pane]');
  if (!persistentContainer) {
    return false;
  }
  return persistentContainer.getAttribute('data-persistent-visible') !== 'true';
}

function getFileTreeElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${FILE_TREE_ID}"]`);
}

function isPointInsideFileTree(clientX: number, clientY: number): boolean {
  const fileTree = getFileTreeElement();
  return Boolean(
    fileTree
    && hasVisibleRect(fileTree)
    && isPointInsideRect(clientX, clientY, fileTree.getBoundingClientRect()),
  );
}

function findDropSurfaceAtPoint(clientX: number, clientY: number): FileDropSurface | null {
  if (isPointInsideFileTree(clientX, clientY)) {
    return null;
  }

  const sidebar = document.querySelector<HTMLElement>(`[data-testid="${AGENT_SIDEBAR_ID}"]`);
  if (sidebar && hasVisibleRect(sidebar) && isPointInsideRect(clientX, clientY, sidebar.getBoundingClientRect())) {
    return { kind: 'sidebar', element: sidebar };
  }

  const composer = Array.from(document.querySelectorAll<HTMLElement>('[data-file-drop-surface="composer"]'))
    .find((element) => (
      hasVisibleRect(element)
      && !isHiddenPersistentPaneElement(element)
      && isPointInsideRect(clientX, clientY, element.getBoundingClientRect())
    ));
  if (composer) {
    return { kind: 'composer', element: composer };
  }

  const pane = Array.from(document.querySelectorAll<HTMLElement>(PANE_CONTENT_ANY_SELECTOR))
    .find((element) => (
      hasVisibleRect(element)
      && !isHiddenPersistentPaneElement(element)
      && isPointInsideRect(clientX, clientY, element.getBoundingClientRect())
    ));
  if (pane) {
    return { kind: 'pane', element: pane };
  }

  return null;
}

function createSyntheticDragEvent(
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  dataTransfer: DataTransfer,
  clientX: number,
  clientY: number,
): DragEvent {
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    dataTransfer,
  });
  (event as DragEvent & { __fileDragSynthetic?: boolean }).__fileDragSynthetic = true;
  return event;
}

export function FileDropOverlay() {
  const [isActive, setIsActive] = useState(false);
  const lastSurfaceRef = useRef<FileDropSurface | null>(null);
  const lastDataTransferRef = useRef<DataTransfer | null>(null);
  const lastDragClientXRef = useRef(0);
  const lastDragClientYRef = useRef(0);
  const inactivityWatchdogRef = useRef<InactivityWatchdog | null>(null);

  const isFileDrag = useCallback((dataTransfer: DataTransfer | null): boolean => {
    if (!dataTransfer) return false;
    return isResolvedFileDrag(dataTransfer) || hasNativeFileDrag(dataTransfer);
  }, []);

  const dispatchSyntheticSurfaceEvent = useCallback((
    surface: FileDropSurface,
    type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
    dataTransfer: DataTransfer,
    clientX: number,
    clientY: number,
  ) => {
    surface.element.dispatchEvent(createSyntheticDragEvent(type, dataTransfer, clientX, clientY));
  }, []);

  const clearSurface = useCallback((dataTransfer: DataTransfer | null, clientX: number, clientY: number) => {
    const previous = lastSurfaceRef.current;
    if (!previous) return;
    logFileDropOverlay('surface-leave', {
      kind: previous.kind,
      clientX,
      clientY,
      targetTestId: previous.element.getAttribute('data-testid'),
      targetPath: previous.element.getAttribute('data-path'),
    });
    if (dataTransfer) {
      dispatchSyntheticSurfaceEvent(previous, 'dragleave', dataTransfer, clientX, clientY);
    }
    lastSurfaceRef.current = null;
  }, [dispatchSyntheticSurfaceEvent]);

  const syncSurface = useCallback((
    surface: FileDropSurface | null,
    dataTransfer: DataTransfer,
    clientX: number,
    clientY: number,
  ) => {
    const previous = lastSurfaceRef.current;
    if (previous?.element === surface?.element) {
      if (surface) {
        dispatchSyntheticSurfaceEvent(surface, 'dragover', dataTransfer, clientX, clientY);
      }
      return;
    }

    if (previous) {
      clearSurface(dataTransfer, clientX, clientY);
    }

    lastSurfaceRef.current = surface;
    if (!surface) {
      return;
    }

    logFileDropOverlay('surface-enter', {
      kind: surface.kind,
      clientX,
      clientY,
      targetTestId: surface.element.getAttribute('data-testid'),
      targetPath: surface.element.getAttribute('data-path'),
    });
    dispatchSyntheticSurfaceEvent(surface, 'dragenter', dataTransfer, clientX, clientY);
    dispatchSyntheticSurfaceEvent(surface, 'dragover', dataTransfer, clientX, clientY);
  }, [clearSurface, dispatchSyntheticSurfaceEvent]);

  const clearInactivityWatchdog = useCallback(() => {
    inactivityWatchdogRef.current?.clear();
  }, []);

  const deactivate = useCallback((dataTransfer?: DataTransfer, clientX = 0, clientY = 0) => {
    const effectiveDataTransfer = dataTransfer ?? lastDataTransferRef.current;
    clearSurface(effectiveDataTransfer, clientX, clientY);
    lastDataTransferRef.current = null;
    clearInactivityWatchdog();
    setIsActive(false);
  }, [clearInactivityWatchdog, clearSurface]);

  const ensureInactivityWatchdog = useCallback(() => {
    if (!inactivityWatchdogRef.current) {
      inactivityWatchdogRef.current = createInactivityWatchdog(
        DRAG_INACTIVITY_TIMEOUT_MS,
        () => {
          logFileDropOverlay('timeout-reset', {
            clientX: lastDragClientXRef.current,
            clientY: lastDragClientYRef.current,
            timeoutMs: DRAG_INACTIVITY_TIMEOUT_MS,
          });
          deactivate(undefined, lastDragClientXRef.current, lastDragClientYRef.current);
        },
      );
    }
    return inactivityWatchdogRef.current;
  }, [deactivate]);

  const registerDragActivity = useCallback((dataTransfer: DataTransfer | null, clientX: number, clientY: number) => {
    if (!dataTransfer) {
      return;
    }

    lastDataTransferRef.current = dataTransfer;
    lastDragClientXRef.current = clientX;
    lastDragClientYRef.current = clientY;
    ensureInactivityWatchdog().poke();
  }, [ensureInactivityWatchdog]);

  useEffect(() => {
    if (isActive) {
      document.documentElement.dataset.fileDropOverlayActive = 'true';
    } else {
      delete document.documentElement.dataset.fileDropOverlayActive;
    }

    return () => {
      delete document.documentElement.dataset.fileDropOverlayActive;
    };
  }, [isActive]);

  useEffect(() => {
    const handleDocumentDrag = (event: DragEvent) => {
      if (isSyntheticDragEvent(event) || !isFileDrag(event.dataTransfer)) {
        return;
      }

      registerDragActivity(event.dataTransfer, event.clientX, event.clientY);

      if (isPointInsideFileTree(event.clientX, event.clientY)) {
        return;
      }

      if (!isActive) {
        logFileDropOverlay('activate', {
          clientX: event.clientX,
          clientY: event.clientY,
          types: Array.from(event.dataTransfer?.types ?? []),
        });
        setIsActive(true);
      }
    };

    const handleDocumentDragEnd = (event: DragEvent) => {
      if (isSyntheticDragEvent(event)) {
        return;
      }
      deactivate(event.dataTransfer ?? undefined, event.clientX, event.clientY);
    };

    const handleDocumentDrop = (event: DragEvent) => {
      if (isSyntheticDragEvent(event) || !isFileDrag(event.dataTransfer)) {
        return;
      }
      deactivate(event.dataTransfer ?? undefined, event.clientX, event.clientY);
    };

    const handleDocumentDragLeave = (event: DragEvent) => {
      if (isSyntheticDragEvent(event) || !isFileDrag(event.dataTransfer)) {
        return;
      }
      if ((event.clientX !== 0 || event.clientY !== 0) && isOutsideWindow(event.clientX, event.clientY)) {
        deactivate(event.dataTransfer ?? undefined, event.clientX, event.clientY);
      }
    };

    const handleWindowBlur = () => {
      deactivate();
    };

    document.addEventListener('dragenter', handleDocumentDrag, true);
    document.addEventListener('dragover', handleDocumentDrag, true);
    document.addEventListener('dragend', handleDocumentDragEnd, true);
    document.addEventListener('drop', handleDocumentDrop, true);
    document.addEventListener('dragleave', handleDocumentDragLeave, true);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      document.removeEventListener('dragenter', handleDocumentDrag, true);
      document.removeEventListener('dragover', handleDocumentDrag, true);
      document.removeEventListener('dragend', handleDocumentDragEnd, true);
      document.removeEventListener('drop', handleDocumentDrop, true);
      document.removeEventListener('dragleave', handleDocumentDragLeave, true);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [deactivate, isActive, isFileDrag, registerDragActivity]);

  useEffect(() => {
    ensureInactivityWatchdog();
    return () => {
      clearInactivityWatchdog();
      inactivityWatchdogRef.current = null;
    };
  }, [clearInactivityWatchdog, ensureInactivityWatchdog]);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    const { clientX, clientY } = event;
    registerDragActivity(event.dataTransfer, clientX, clientY);
    if (isPointInsideFileTree(clientX, clientY)) {
      deactivate(event.dataTransfer, clientX, clientY);
      return;
    }

    const surface = findDropSurfaceAtPoint(clientX, clientY);
    if (!surface) {
      clearSurface(event.dataTransfer, clientX, clientY);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = surface.kind === 'pane' ? 'move' : 'copy';
    syncSurface(surface, event.dataTransfer, clientX, clientY);
  }, [clearSurface, deactivate, isFileDrag, syncSurface]);

  const handleDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    const { clientX, clientY } = event;
    registerDragActivity(event.dataTransfer, clientX, clientY);
    const surface = findDropSurfaceAtPoint(clientX, clientY);
    logFileDropOverlay('drop', {
      kind: surface?.kind ?? null,
      clientX,
      clientY,
      targetTestId: surface?.element.getAttribute('data-testid') ?? null,
      targetPath: surface?.element.getAttribute('data-path') ?? null,
      types: Array.from(event.dataTransfer.types ?? []),
    });

    if (surface) {
      event.preventDefault();
      event.stopPropagation();
      dispatchSyntheticSurfaceEvent(surface, 'drop', event.dataTransfer, clientX, clientY);
      clearSurface(event.dataTransfer, clientX, clientY);
    }

    deactivate(event.dataTransfer, clientX, clientY);
  }, [clearSurface, deactivate, dispatchSyntheticSurfaceEvent, isFileDrag]);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (event.relatedTarget) {
      return;
    }
    registerDragActivity(event.dataTransfer, event.clientX, event.clientY);
    logFileDropOverlay('dragleave', {
      clientX: event.clientX,
      clientY: event.clientY,
    });
    if ((event.clientX !== 0 || event.clientY !== 0) && isOutsideWindow(event.clientX, event.clientY)) {
      deactivate(event.dataTransfer, event.clientX, event.clientY);
    }
  }, [deactivate, registerDragActivity]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      data-testid="file-drop-overlay"
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        pointerEvents: isActive ? 'auto' : 'none',
        background: 'transparent',
      }}
    />,
    document.body,
  );
}
